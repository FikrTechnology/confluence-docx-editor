# confluence-docx-editor
Confluence document editor.

## Reference DOCX Template

Download output uses a reference DOCX when available. Locally, the application automatically looks for:

```text
templates_doc/R6 - Partner Edit Screen.docx
```

For another template, set `REFERENCE_DOCX` to its path before starting the server:

```powershell
$env:REFERENCE_DOCX = "C:\path\to\template.docx"
node server.js
```

The reference template supplies Word styles, fonts, theme colors, numbering, page layout, and table defaults to DOCX output. DOC output is converted from that generated DOCX through LibreOffice.

Do not commit business documents or confidential templates to this public repository. For Koyeb, use a private repository or a deployment asset with access control and set `REFERENCE_DOCX` to the mounted template path.
