#!/usr/bin/env python3
"""Read the canonical XLSX using only Python's standard library.

No outreach permission is inferred. Output belongs outside the public/repository
folder. Convert once, then upload the resulting JSON using CRM Import preview.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import posixpath
import re
import unicodedata
import xml.etree.ElementTree as ET
import zipfile

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
EMAIL = re.compile(r'[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+')
URL = re.compile(r'https?://[^\s<>"\u201c\u201d]+')


def norm(value):
    return ' '.join(unicodedata.normalize('NFKC', str(value or '')).casefold().split())


def exclusion(value):
    text = re.sub(r'[^a-z0-9]', '', norm(value))
    return next((alias for alias in ('usmp', 'recirq', 'araglobal') if alias in text), None)


def unique(values):
    return list(dict.fromkeys(v for v in values if v))


def strings(value):
    return str(value) if value is not None else ''


def column(ref):
    result = 0
    for ch in re.match(r'[A-Z]+', ref).group():
        result = result * 26 + ord(ch) - 64
    return result - 1


def read_workbook(path):
    """Preserve cell text, cached scalar values and formulas."""
    sheets = {}
    with zipfile.ZipFile(path) as archive:
        if sum(i.file_size for i in archive.infolist()) > 150_000_000:
            raise ValueError('Workbook exceeds uncompressed size limit')
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            shared = [''.join(t.text or '' for t in e.findall('.//s:t', NS))
                      for e in ET.fromstring(archive.read('xl/sharedStrings.xml'))]
        rels = {e.get('Id'): e.get('Target') for e in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        for sheet in ET.fromstring(archive.read('xl/workbook.xml')).findall('s:sheets/s:sheet', NS):
            target = rels[sheet.get('{%s}id' % REL)]
            target = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
            root = ET.fromstring(archive.read(target))
            rows = []
            for row in root.findall('s:sheetData/s:row', NS):
                cells = {}
                for cell in row.findall('s:c', NS):
                    val = cell.find('s:v', NS)
                    val = val.text if val is not None else None
                    kind = cell.get('t')
                    if kind == 's': val = shared[int(val)]
                    elif kind == 'inlineStr': val = ''.join(t.text or '' for t in cell.findall('.//s:t', NS))
                    elif kind == 'b' and val is not None: val = val == '1'
                    elif kind not in ('str', 'e', 'd') and val is not None:
                        try: val = int(val) if '.' not in val and 'e' not in val.lower() else float(val)
                        except ValueError: pass
                    formula = cell.find('s:f', NS)
                    cells[column(cell.get('r'))] = val
                    if formula is not None:
                        cells[str(cell.get('r')) + ':formula'] = formula.text
                rows.append((int(row.get('r')), cells))
            sheets[sheet.get('name')] = rows
    return sheets


def table(rows, first_header):
    headers = None
    result = []
    for row_number, cells in rows:
        if headers is None:
            if norm(cells.get(0)) == norm(first_header):
                headers = {k: strings(v) for k, v in cells.items() if isinstance(k, int) and v}
            continue
        if not any(v not in (None, '') for v in cells.values()): continue
        raw = {name: cells.get(index) for index, name in headers.items()}
        for key, val in cells.items():
            if isinstance(key, str): raw[key] = val
        result.append((row_number, raw))
    if headers is None: raise ValueError('Missing expected header: ' + first_header)
    return result


def phone_values(value):
    # Keep the published formatting and annotations; never add a country code.
    return [p.strip() for p in re.split(r'[;\n|]', strings(value))
            if len(re.sub(r'\D', '', p)) >= 6]


def make_key(sheet, row):
    identity = strings(row.get('ID')).strip()
    if identity: return sheet + ':' + identity
    basis = '\x1f'.join(norm(row.get(k)) for k in ('Business', 'Country', 'City'))
    return sheet + ':sha256:' + hashlib.sha256(basis.encode()).hexdigest()


def convert(path, library_file_id, version):
    sheets = read_workbook(path)
    prospects = table(sheets['Prospects'], 'ID')
    contacts = table(sheets.get('Contacts', []), 'Business ID') if 'Contacts' in sheets else []
    research = table(sheets.get('Research', []), 'Business ID') if 'Research' in sheets else []
    indexes = {}
    for label, rows in [('Contacts', contacts), ('Research', research)]:
        index = defaultdict(list)
        for number, row in rows: index[strings(row.get('Business ID')).strip()].append((number, row))
        indexes[label] = index
    output = {'schemaVersion': 1, 'source': {'libraryFileId': library_file_id, 'version': version,
              'filename': Path(path).name, 'sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest()},
              'records': [], 'held': [], 'excluded': []}
    warnings = []
    for number, row in prospects:
        if not row.get('Business'): raise ValueError('Missing business at Prospects row ' + str(number))
        key = make_key('Prospects', row)
        reason = exclusion(row.get('Business')) or exclusion(row.get('Website'))
        descriptor = {'sourceRowKey': key, 'company': row['Business'], 'sourceSheet': 'Prospects', 'sourceRow': number}
        if reason:
            output['excluded'].append(dict(descriptor, reason='Excluded alias: ' + reason)); continue
        if any(re.search(r'\bhold\b', norm(row.get(k))) for k in ('Suggested priority', 'Contact status')):
            output['held'].append(dict(descriptor, reason=strings(row.get('Next qualification')))); continue
        linked = [('Prospects', number, row)]
        for sheet in ('Contacts', 'Research'):
            linked += [(sheet, n, r) for n, r in indexes[sheet].get(strings(row.get('ID')).strip(), [])]
        raw = dict(row)
        notes = ['Research prospect only. Marketing consent, purchasing authority and current buying demand are not inferred.']
        emails, phones, whatsapp, names, urls = [], phone_values(row.get('Preferred number')), [], [], []
        for sheet, n, data in linked:
            notes.append(sheet + ' row ' + str(n) + ':\n' + '\n'.join(k + ': ' + strings(v) for k, v in data.items() if v not in ('', None)))
            if sheet != 'Prospects':
                for k, v in data.items(): raw[sheet + ' row ' + str(n) + ' / ' + k] = v
            urls += [u.rstrip('.,;)') for v in data.values() for u in URL.findall(strings(v))]
            if sheet == 'Contacts':
                emails += EMAIL.findall(strings(data.get('Business email')))
                phones += phone_values(data.get('Phone'))
                whatsapp += phone_values(data.get('WhatsApp number'))
                if data.get('Person / desk'): names.append(strings(data['Person / desk']))
        if not names and row.get('Best contact'): names.append(strings(row['Best contact']))
        output['records'].append({'sourceRowKey': key, 'company': row['Business'], 'country': row.get('Country'),
            'city': row.get('City'), 'website': row.get('Website'), 'emails': unique(emails), 'phones': unique(phones),
            'whatsapp': unique(whatsapp), 'contactNames': unique(names), 'category': None,
            'priority': row.get('Suggested priority'), 'sourceUrls': unique(urls), 'sourceNotes': '\n\n'.join(notes), 'rawFields': raw})
    # Identity review exclusions are audit entries only, never contact-bearing imports.
    if 'Identity review' in sheets:
        for number, row in table(sheets['Identity review'], 'Entity / alias'):
            alias = exclusion(row.get('Entity / alias'))
            if alias:
                output['excluded'].append({'sourceSheet': 'Identity review', 'sourceRow': number,
                    'company': row.get('Entity / alias'), 'reason': 'Excluded alias: ' + alias,
                    'rawFields': row})
    groups = defaultdict(list)
    for record in output['records']: groups[record['sourceRowKey']].append(record)
    duplicates = [{'sourceRowKey': key, 'count': len(rows), 'conflicting': any(r != rows[0] for r in rows[1:])}
                  for key, rows in groups.items() if len(rows) > 1]
    if duplicates: warnings.append('Duplicate stable keys must be resolved before importing.')
    master_ids = {strings(row.get('ID')).strip() for _, row in prospects}
    unmatched = {sheet: [{'sourceRow': n, 'businessId': r.get('Business ID'), 'company': r.get('Business')}
                         for n, r in rows if strings(r.get('Business ID')).strip() not in master_ids]
                 for sheet, rows in [('Contacts', contacts), ('Research', research)]}
    identity_groups = defaultdict(list)
    for rec in output['records']:
        identity_groups[tuple(norm(rec.get(k)) for k in ('company', 'country', 'city'))].append(rec['sourceRowKey'])
    duplicate_identities = [keys for keys in identity_groups.values() if len(keys) > 1]
    shared = {}
    for field in ('emails', 'phones', 'whatsapp'):
        mapping = defaultdict(set)
        for rec in output['records']:
            for value in rec[field]:
                canonical = norm(value) if field == 'emails' else re.sub(r'\D', '', value)
                mapping[canonical].add(rec['sourceRowKey'])
        shared[field] = [{'value': value, 'sourceRowKeys': sorted(keys)} for value, keys in mapping.items() if len(keys) > 1]
    audit = {'source': output['source'], 'counts': {'masterRows': len(prospects), 'records': len(output['records']),
             'held': len(output['held']), 'excluded': len(output['excluded']), 'contactRows': len(contacts),
             'researchRows': len(research)}, 'duplicateKeys': duplicates, 'duplicateCompanyCountryCity': duplicate_identities, 'unmatchedRelatedRows': unmatched,
             'sharedContactRoutes': shared, 'warnings': warnings,
             'notImportedSheets': [s for s in sheets if s not in ('Prospects', 'Contacts', 'Research', 'Identity review')],
             'workflow': 'Convert Excel once. Upload sanitized JSON using CRM Import preview. Review duplicate/conflict and hold counts before confirming. Verify contact currency, buyer authority and permission before any marketing. User contacts, reserves and daily logs are not separate business imports.',
             'limitations': ['Missing values preserved as null or original empty strings.', 'Category not inferred.',
                            'Phone country codes not inferred; published formatting retained.',
                            'Contact names include desk labels as published, not verified people.',
                            'Shared contact routes are review flags, not proof of duplicate companies.',
                            'Held and excluded master rows have no contact details in the JSON.']}
    return output, audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbook', type=Path)
    parser.add_argument('--library-file-id', required=True)
    parser.add_argument('--version', type=int, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if 'public' in args.output.resolve().parts: parser.error('Contact data must not be written inside public/')
    data, audit = convert(args.workbook, args.library_file_id, args.version)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    audit_path = args.output.with_name(args.output.stem + '.audit.json')
    audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
    args.output.chmod(0o600); audit_path.chmod(0o600)
    print(json.dumps(audit['counts']))
    if audit['duplicateKeys']: raise SystemExit('Duplicate stable keys found; review audit before import.')


if __name__ == '__main__': main()
