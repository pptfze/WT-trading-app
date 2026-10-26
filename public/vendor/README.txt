Optional Excel export dependency

The original browser-loaded third-party XLSX script was removed. To enable Excel
export, the operator must place an audited, appropriately licensed SheetJS
xlsx.full.min.js build in this directory. No library was downloaded or installed
during this fix. Other app features and privacy tests do not need this asset.
