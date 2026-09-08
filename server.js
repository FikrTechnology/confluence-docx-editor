const express = require('express');
const fileUpload = require('express-fileupload');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const JSZip = require('jszip');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json({ limit: '500mb' })); 
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(fileUpload({ limits: { fileSize: 500 * 1024 * 1024 } })); 

fs.ensureDirSync(path.join(__dirname, 'uploads'));

function getAllFilesRecursive(dirPath, arrayOfFiles) {
    const files = fs.readdirSync(dirPath);
    arrayOfFiles = arrayOfFiles || [];

    files.forEach(function(file) {
        if (fs.statSync(dirPath + "/" + file).isDirectory()) {
            arrayOfFiles = getAllFilesRecursive(dirPath + "/" + file, arrayOfFiles);
        } else {
            arrayOfFiles.push(path.join(dirPath, file));
        }
    });

    return arrayOfFiles;
}

function processExtractedMedia(mediaDir, htmlContent) {
    if (!fs.existsSync(mediaDir)) return htmlContent;

    try {
        const allFiles = getAllFilesRecursive(mediaDir);
        
        allFiles.forEach(filePath => {
            let file = path.basename(filePath);
            let ext = path.extname(file).toLowerCase();
            let originalName = file;

            // Konversi format vektor Word (EMF/WMF) ke PNG agar dapat dirender browser
            if (ext === '.emf' || ext === '.wmf') {
                const pngPath = filePath.replace(new RegExp(`\\${ext}$`, 'i'), '.png');
                try {
                    execSync(`convert "${filePath}" "${pngPath}"`);
                    filePath = pngPath; 
                    ext = '.png';
                } catch (convertErr) {
                    console.error(`Gagal convert ${file}:`, convertErr.message);
                }
            }

            // Baca file gambar dan ubah menjadi Data URL (Base64)
            if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
                try {
                    const imageBuffer = fs.readFileSync(filePath);
                    const base64Data = imageBuffer.toString('base64');
                    const mimeType = ext === '.svg' ? 'image/svg+xml' : `image/${ext.replace('.', '')}`;
                    const dataUrl = `data:${mimeType};base64,${base64Data}`;

                    const escapedName = originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`src=["'][^"']*?${escapedName}["']`, 'gi');
                    htmlContent = htmlContent.replace(regex, `src="${dataUrl}"`);
                } catch (readErr) {
                    console.error(`Gagal memproses Base64 ${file}:`, readErr.message);
                }
            }
        });
    } catch (err) {
        console.error("Error reading media directories:", err);
    }

    return htmlContent;
}

async function applyWordTableGrid(docxPath) {
    const docxBuffer = await fs.readFile(docxPath);
    const zip = await JSZip.loadAsync(docxBuffer);
    const documentEntry = zip.file('word/document.xml');

    if (!documentEntry) {
        throw new Error('DOCX tidak memiliki word/document.xml');
    }

    let documentXml = await documentEntry.async('string');
    const borderXml = '<w:top w:val="single" w:sz="8" w:space="0" w:color="000000"/><w:left w:val="single" w:sz="8" w:space="0" w:color="000000"/><w:bottom w:val="single" w:sz="8" w:space="0" w:color="000000"/><w:right w:val="single" w:sz="8" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="8" w:space="0" w:color="000000"/><w:insideV w:val="single" w:sz="8" w:space="0" w:color="000000"/>';

    // Table Grid style plus explicit borders makes the result independent of Word's theme.
    documentXml = documentXml.replace(/<w:tblPr>([\s\S]*?)<\/w:tblPr>/g, (match, tableProperties) => {
        const withoutBorders = tableProperties.replace(/<w:tblBorders>[\s\S]*?<\/w:tblBorders>/g, '');
        const withoutStyle = withoutBorders.replace(/<w:tblStyle[^>]*\/>/g, '');
        return `<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblBorders>${borderXml}</w:tblBorders>${withoutStyle}</w:tblPr>`;
    });

    documentXml = documentXml.replace(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/g, (match, cellProperties) => {
        const withoutBorders = cellProperties.replace(/<w:tcBorders>[\s\S]*?<\/w:tcBorders>/g, '');
        return `<w:tcPr><w:tcBorders>${borderXml}</w:tcBorders>${withoutBorders}</w:tcPr>`;
    });

    zip.file('word/document.xml', documentXml);
    await fs.writeFile(docxPath, await zip.generateAsync({ type: 'nodebuffer' }));
}

// Endpoint Upload DOCX -> HTML
app.post('/api/upload', (req, res) => {
    if (!req.files || !req.files.document) return res.status(400).send('Tidak ada file yang diunggah.');

    const file = req.files.document;
    const time = Date.now();
    const inputPath = path.join(__dirname, 'uploads', `input_${time}.docx`);
    const outputPath = path.join(__dirname, 'uploads', `output_${time}.html`);
    const mediaDir = path.join(__dirname, 'uploads', `media_${time}`);

    fs.ensureDirSync(mediaDir);

    file.mv(inputPath, (err) => {
        if (err) return res.status(500).send('Gagal memindahkan file sementara.');

        exec(`pandoc "${inputPath}" -f docx -t html --extract-media="${mediaDir}" -o "${outputPath}"`, (execErr) => {
            if (execErr) {
                console.error('Pandoc Error:', execErr);
                return res.status(500).send('Gagal konversi dokumen ke HTML.');
            }

            try {
                let htmlContent = fs.readFileSync(outputPath, 'utf8');
                htmlContent = processExtractedMedia(mediaDir, htmlContent);

                res.json({ html: htmlContent });
            } catch (err) {
                console.error('File Read Error:', err);
                res.status(500).send('Terjadi kesalahan saat membaca output HTML.');
            } finally {
                fs.removeSync(inputPath);
                fs.removeSync(outputPath);
                fs.removeSync(mediaDir);
            }
        });
    });
});

// Endpoint Download HTML -> DOCX
app.post('/api/download', (req, res) => {
    const { htmlContent } = req.body;
    if (!htmlContent) return res.status(400).send('Konten dokumen kosong.');

    const time = Date.now();
    const tempHtmlPath = path.join(__dirname, 'uploads', `temp_${time}.html`);
    const outputDocxPath = path.join(__dirname, 'uploads', `Document_${time}.docx`);

    // Enhance table dengan inline CSS style yang explicit untuk border rendering di DOCX
    let enhancedHtml = htmlContent;
    
    // Process semua table
    enhancedHtml = enhancedHtml.replace(/<table([^>]*)>/gi, function(match, attrs) {
      // Extract existing style jika ada
      let styleMatch = attrs.match(/style="([^"]*)"/i);
      let existingStyle = styleMatch ? styleMatch[1] : '';
      
      // Build style dengan border yang explicit
      let newStyle = existingStyle
        .replace(/border-collapse:\s*[^;]*/gi, '') // Remove existing
        .replace(/border:\s*[^;]*/gi, '')
        .replace(/width:\s*[^;]*/gi, '') + 
        '; border-collapse: collapse; border: 1px solid #000; width: 100%';
      
      // Ensure attributes
      let newAttrs = attrs.replace(/border="[^"]*"/gi, '').replace(/cellpadding="[^"]*"/gi, '').replace(/cellspacing="[^"]*"/gi, '');
      newAttrs = newAttrs.replace(/style="[^"]*"/i, `style="${newStyle.trim()}"`);
      
      if (!newAttrs.includes('style=')) {
        newAttrs = ` border="1" cellpadding="6" cellspacing="0" style="${newStyle.trim()}"` + newAttrs;
      }
      
      return `<table${newAttrs}>`;
    });
    
    // Process semua td dan th dengan style border explicit
    enhancedHtml = enhancedHtml.replace(/<(td|th)([^>]*)>/gi, function(match, tag, attrs) {
      let styleMatch = attrs.match(/style="([^"]*)"/i);
      let existingStyle = styleMatch ? styleMatch[1] : '';
      
      // Build cell style dengan border explicit
      let newStyle = existingStyle
        .replace(/border:\s*[^;]*/gi, '')
        .replace(/padding:\s*[^;]*/gi, '') +
        '; border: 1px solid #000; padding: 6px 8px; vertical-align: top';
      
      let newAttrs = attrs.replace(/style="[^"]*"/i, `style="${newStyle.trim()}"`);
      if (!newAttrs.includes('style=')) {
        newAttrs = `${newAttrs} style="${newStyle.trim()}"`;
      }
      
      return `<${tag}${newAttrs}>`;
    });

    const fullHtml = `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Calibri, Arial, sans-serif; 
            font-size: 11pt; 
            line-height: 1.5; 
            color: #000000; 
            margin: 0;
            padding: 0;
        }
        table { 
            border-collapse: collapse; 
            border: 1px solid #000000;
            width: 100%; 
            margin: 0 0 12pt 0; 
        }
        td, th { 
            border: 1px solid #000000; 
            padding: 6px 8px; 
            text-align: left; 
            vertical-align: top;
            margin: 0;
        }
        th { 
            font-weight: bold; 
            background-color: #f2f2f2; 
        }
        tr { 
            height: auto; 
        }
        img { 
            max-width: 100%; 
            height: auto; 
            display: block; 
        }
        p { 
            margin: 0 0 8pt 0; 
        }
        h1, h2, h3, h4, h5, h6 { 
            font-family: 'Segoe UI', Arial, sans-serif; 
            color: #111111; 
            margin: 12pt 0 4pt 0; 
        }
    </style>
</head>
<body>
${enhancedHtml}
</body>
</html>`;
    
    fs.writeFileSync(tempHtmlPath, fullHtml);

    const pandocCmd = `pandoc "${tempHtmlPath}" -f html -t docx -o "${outputDocxPath}"`;

    exec(pandocCmd, async (execErr) => {
        if (execErr) {
            console.error('Pandoc Download Error:', execErr);
            fs.removeSync(tempHtmlPath);
            return res.status(500).send('Gagal konversi kembali ke DOCX: ' + execErr.message);
        }

        try {
            await applyWordTableGrid(outputDocxPath);
        } catch (borderErr) {
            console.error('DOCX Table Grid Error:', borderErr);
            fs.removeSync(tempHtmlPath);
            fs.removeSync(outputDocxPath);
            return res.status(500).send('Gagal menambahkan border Table Grid ke DOCX.');
        }

        res.download(outputDocxPath, 'Dokumen_Arsitektur_Update.docx', () => {
            fs.removeSync(tempHtmlPath);
            fs.removeSync(outputDocxPath);
        });
    });
});

app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));