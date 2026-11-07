"""Synthetic-only converter regression tests; no real prospect data."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('converter', Path(__file__).resolve().parents[1] / 'scripts/prepare-crm-import.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def sheet(headers, rows):
    return [(7, dict(enumerate(headers)))] + [(n + 8, dict(enumerate(row))) for n, row in enumerate(rows)]


class ConversionTests(unittest.TestCase):
    def run_conversion(self, rows, contacts=None):
        sheets = {'Prospects': sheet(['ID', 'Business', 'Country', 'City', 'Website', 'Contact status', 'Suggested priority', 'Preferred number'], rows)}
        if contacts is not None:
            sheets['Contacts'] = sheet(['Business ID', 'Business', 'Person / desk', 'Phone', 'WhatsApp number', 'Business email', 'Contact limitations', 'Source URLs'], contacts)
        with tempfile.NamedTemporaryFile(suffix='.xlsx') as f:
            f.write(b'synthetic source'); f.flush()
            with patch.object(m, 'read_workbook', return_value=sheets):
                return m.convert(f.name, 'synthetic-file-id', 38)

    def test_exclusions_and_hold_never_expose_contacts(self):
        rows = [[str(i), name, None, '', '', status, '', '+123456789'] for i, (name, status) in enumerate([
            ('U.S.M.P.', ''), ('recirQ', ''), ('ARA Global Group, Inc.', ''), ('Hold Example', 'HOLD / compliance review'), ('Safe Example', '')])]
        data, audit = self.run_conversion(rows)
        self.assertEqual([r['company'] for r in data['records']], ['Safe Example'])
        self.assertEqual(len(data['held']), 1)
        self.assertEqual(len(data['excluded']), 3)
        self.assertNotIn('+123456789', str(data['held']) + str(data['excluded']))

    def test_provenance_unknowns_and_no_phone_inference(self):
        rows = [['S-1', 'Synthetic Example', None, '', 'https://example.invalid', '', '', '5551234567']]
        contacts = [['S-1', 'Synthetic Example', 'Desk; role uncertain', '5551234567', '', 'sales@example.invalid', 'Historical number; permission unknown', 'https://example.invalid/source']]
        data, _ = self.run_conversion(rows, contacts)
        r = data['records'][0]
        self.assertIsNone(r['country'])
        self.assertEqual(r['city'], '')
        self.assertEqual(r['phones'], ['5551234567'])
        self.assertEqual(r['whatsapp'], [])
        self.assertEqual(r['sourceRowKey'], 'Prospects:S-1')
        self.assertEqual(r['rawFields']['Contacts row 8 / Contact limitations'], 'Historical number; permission unknown')
        self.assertIn('permission unknown', r['sourceNotes'])
        self.assertNotIn('consent', r)

    def test_stable_key_ignores_sort_order_and_contact_changes(self):
        a = {'ID': None, 'Business': ' Example Company ', 'Country': 'Unspecified', 'City': 'City'}
        b = dict(a, Business='example company', Phone='new number')
        self.assertEqual(m.make_key('Prospects', a), m.make_key('Prospects', b))
        self.assertNotEqual(m.make_key('Prospects', a), m.make_key('Other', a))

    def test_duplicate_ids_and_shared_contacts_reported(self):
        rows = [['S-1', 'Example A', '', '', '', '', '', '5551234567'], ['S-1', 'Example B', '', '', '', '', '', '5551234567'], ['S-2', 'Example C', '', '', '', '', '', '(555) 1234567']]
        _, audit = self.run_conversion(rows)
        self.assertEqual(len(audit['duplicateKeys']), 1)
        self.assertTrue(audit['duplicateKeys'][0]['conflicting'])
        self.assertEqual(len(audit['sharedContactRoutes']['phones']), 1)

    def test_xlsx_relationships_sparse_shared_inline_boolean_formula(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'synthetic.xlsx'
            with zipfile.ZipFile(p, 'w') as z:
                z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Example" r:id="r1"/></sheets></workbook>')
                z.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
                z.writestr('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Example</t></si></sst>')
                z.writestr('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Text</t></is></c><c r="D1" t="b"><v>1</v></c><c r="E1"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>')
            row = m.read_workbook(p)['Example'][0][1]
            self.assertEqual(row[0], 'Example')
            self.assertNotIn(1, row)
            self.assertEqual(row[2], 'Text')
            self.assertTrue(row[3])
            self.assertEqual(row[4], 3)
            self.assertEqual(row['E1:formula'], '1+2')


if __name__ == '__main__': unittest.main()
