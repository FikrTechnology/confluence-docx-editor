const express = require('express');
const fileUpload = require('express-fileupload');
const { execFile, execFileSync } = require('child_process');
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
                    execFileSync('convert', [filePath, pngPath]);
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

function decodeQuotedPrintable(value) {
    return value
        .replace(/=\r?\n/g, '')
        .replace(/=([a-f0-9]{2})/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseMimeHeaders(headerText) {
    const headers = {};
    headerText.split(/\r?\n/).forEach(line => {
        const separator = line.indexOf(':');
        if (separator > 0) {
            headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
        }
    });
    return headers;
}

function extractConfluenceHtmlDoc(inputPath, mediaDir, outputPath) {
    const raw = fs.readFileSync(inputPath);
    const text = raw.toString('utf8');
    const isMimeExport = /multipart\/related/i.test(text) && /<html[\s>]/i.test(text);

    if (!isMimeExport && !/<html[\s>]/i.test(text)) return false;

    let htmlContent = text;
    if (isMimeExport) {
        const boundaryMatch = text.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\r\n]+))/i);
        if (!boundaryMatch) throw new Error('Boundary MIME pada file DOC tidak ditemukan.');

        const boundary = boundaryMatch[1] || boundaryMatch[2];
        const parts = text.split(`--${boundary}`);
        const imageReferences = [];

        for (const part of parts) {
            const separator = part.search(/\r?\n\r?\n/);
            if (separator < 0) continue;

            const headerText = part.slice(0, separator);
            const body = part.slice(separator).replace(/^\r?\n\r?\n/, '').replace(/\r?\n--$/, '');
            const headers = parseMimeHeaders(headerText);
            const contentType = (headers['content-type'] || '').split(';')[0].toLowerCase();
            const transferEncoding = (headers['content-transfer-encoding'] || '').toLowerCase();

            if (contentType === 'text/html') {
                htmlContent = transferEncoding === 'quoted-printable' ? decodeQuotedPrintable(body) : body;
                continue;
            }

            const isImageAttachment = contentType.startsWith('image/') || contentType === 'application/octet-stream';
            if (isImageAttachment) {
                const contentLocationName = path.basename((headers['content-location'] || '').split('?')[0]);
                const htmlImageMatch = htmlContent.match(new RegExp(`src=["'][^"']*${contentLocationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']*["'][^>]*data-image-src=["'][^"']+\\.([a-z0-9]+)`, 'i'));
                const detectedExtension = htmlImageMatch ? htmlImageMatch[1].toLowerCase() : 'png';
                const extension = contentType.startsWith('image/')
                    ? contentType.split('/')[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg')
                    : detectedExtension;
                const imagePath = path.join(mediaDir, `embedded_${imageReferences.length}.${extension}`);
                const imageBuffer = transferEncoding === 'base64'
                    ? Buffer.from(body.replace(/\s/g, ''), 'base64')
                    : Buffer.from(body, 'binary');
                fs.writeFileSync(imagePath, imageBuffer);

                const contentLocation = headers['content-location'] || '';
                const contentId = (headers['content-id'] || '').replace(/[<>]/g, '');
                imageReferences.push({ imagePath, contentLocation, contentId });
            }
        }

        const dataUrls = imageReferences.map(({ imagePath }) =>
            `data:${contentTypeFromPath(imagePath)};base64,${fs.readFileSync(imagePath).toString('base64')}`
        );

        imageReferences.forEach(({ contentLocation, contentId }, imageIndex) => {
            const dataUrl = dataUrls[imageIndex];
            const keys = [contentLocation, contentId, path.basename(contentLocation || '')].filter(Boolean);
            keys.forEach(key => {
                const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                htmlContent = htmlContent.replace(new RegExp(`(src=["'])${escapedKey}(["'])`, 'gi'), `$1${dataUrl}$2`);
            });
        });

        // Some Confluence exports replace src values with opaque IDs, while the
        // MIME parts keep local attachment names. Map remaining unique sources
        // in document order as a fallback for that export variant.
        let fallbackImageIndex = 0;
        htmlContent = htmlContent.replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (match, prefix, source, suffix) => {
            if (source.startsWith('data:') || fallbackImageIndex >= dataUrls.length) return match;
            const dataUrl = dataUrls[fallbackImageIndex];
            fallbackImageIndex += 1;
            return `${prefix}${dataUrl}${suffix}`;
        });
    }

    fs.writeFileSync(outputPath, htmlContent);
    return true;
}

function contentTypeFromPath(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp'
    }[extension] || 'application/octet-stream';
}

function normalizeCssColors(htmlContent) {
    const normalized = htmlContent.replace(/(color\s*:\s*)rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/gi, (match, prefix, red, green, blue) => {
        const toHex = value => Number(value).toString(16).padStart(2, '0');
        return `${prefix}#${toHex(red)}${toHex(green)}${toHex(blue)}`;
    });

    const tagPattern = /<span\b([^>]*)>|<\/span>/gi;
    const openColorSpans = [];
    return normalized.replace(tagPattern, (tag, attributes) => {
        if (tag.toLowerCase() === '</span>') {
            return openColorSpans.pop() ? '</font>' : '</span>';
        }

        const colorMatch = attributes.match(/(?:^|[;\s"'])color\s*:\s*(#[0-9a-f]{3,8}|[a-z]+)/i);
        if (!colorMatch) {
            openColorSpans.push(false);
            return tag;
        }

        openColorSpans.push(true);
        return `<font color="${colorMatch[1]}">`;
    });
}

function decodeBasicHtmlEntities(value) {
    return value
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
}

function extractColoredText(htmlContent) {
    const coloredText = [];
    const patterns = [
        /<font\b[^>]*\bcolor=["'](#[0-9a-f]{3,8}|[a-z]+)["'][^>]*>([\s\S]*?)<\/font>/gi,
        /<([a-z0-9]+)\b[^>]*\bstyle=["'][^"']*\bcolor\s*:\s*(#[0-9a-f]{3,8}|[a-z]+)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi
    ];

    patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(htmlContent))) {
            const color = pattern === patterns[0] ? match[1] : match[2];
            const content = pattern === patterns[0] ? match[2] : match[3];
            const text = decodeBasicHtmlEntities(content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
            if (text && !coloredText.some(item => item.text === text && item.color === color)) {
                coloredText.push({ text, color });
            }
        }
    });

    return coloredText;
}

async function applyHtmlFontColors(docxPath, htmlContent) {
    const colors = extractColoredText(htmlContent);
    if (!colors.length) return;

    const zip = await JSZip.loadAsync(await fs.readFile(docxPath));
    const documentEntry = zip.file('word/document.xml');
    if (!documentEntry) return;

    let documentXml = await documentEntry.async('string');
    const xmlEscape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const normalizedColors = colors.map(({ text, color }) => ({
        text,
        color: color.length === 4
            ? color.slice(1).split('').map(digit => digit + digit).join('').toUpperCase()
            : color.replace('#', '').slice(0, 6).toUpperCase()
    }));

    documentXml = documentXml.replace(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/gi, (run, content) => {
        const textMatch = content.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/i);
        if (!textMatch) return run;

        const plainText = textMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const matches = [];
        normalizedColors.forEach(({ text, color }) => {
            let fromIndex = 0;
            while (fromIndex < plainText.length) {
                const index = plainText.indexOf(text, fromIndex);
                if (index < 0) break;
                matches.push({ start: index, end: index + text.length, color });
                fromIndex = index + text.length;
            }
        });
        if (!matches.length) return run;

        matches.sort((left, right) => left.start - right.start);
        const segments = [];
        let cursor = 0;
        matches.forEach(({ start, end, color }) => {
            if (start < cursor) return;
            if (start > cursor) segments.push({ text: plainText.slice(cursor, start), color: null });
            segments.push({ text: plainText.slice(start, end), color });
            cursor = end;
        });
        if (cursor < plainText.length) segments.push({ text: plainText.slice(cursor), color: null });

        const baseProperties = (content.match(/<w:rPr>[\s\S]*?<\/w:rPr>/i) || [''])[0]
            .replace(/<w:color\b[^>]*\/>/gi, '');
        return segments.map(({ text, color }) => {
            const properties = color ? `<w:rPr><w:color w:val="${color}"/>${baseProperties.replace(/^<w:rPr>|<\/w:rPr>$/gi, '')}</w:rPr>` : baseProperties;
            return `<w:r>${properties}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
        }).join('');
    });

    zip.file('word/document.xml', documentXml);
    await fs.writeFile(docxPath, await zip.generateAsync({ type: 'nodebuffer' }));
}

function materializeEmbeddedImages(htmlContent, mediaDir) {
    const dataImagePattern = /data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)/gi;
    let imageIndex = 0;

    return htmlContent.replace(dataImagePattern, (match, mimeType, encodedData) => {
        const extension = mimeType.split('/')[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg');
        const sourcePath = path.join(mediaDir, `source_${imageIndex}.${extension}`);
        const outputPath = path.join(mediaDir, `image_${imageIndex}.${extension}`);
        imageIndex += 1;

        try {
            fs.writeFileSync(sourcePath, Buffer.from(encodedData.replace(/\s/g, ''), 'base64'));
            if (['png', 'jpg', 'gif', 'webp'].includes(extension)) {
                execFileSync('convert', [sourcePath, '-resize', '1600x1600>', '-strip', outputPath], { stdio: 'ignore' });
                fs.removeSync(sourcePath);
            } else {
                fs.moveSync(sourcePath, outputPath, { overwrite: true });
            }
            return `file://${outputPath.replace(/\\/g, '/')}`;
        } catch (imageErr) {
            console.error('Embedded image preparation error:', imageErr.message);
            fs.removeSync(sourcePath);
            fs.removeSync(outputPath);
            return match;
        }
    });
}

function getReferenceDocxPath() {
    const configuredPath = process.env.REFERENCE_DOCX;
    const defaultPath = path.join(__dirname, 'templates_doc', 'R6 - Partner Edit Screen.docx');
    const referencePath = configuredPath || defaultPath;
    return fs.existsSync(referencePath) ? referencePath : null;
}

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 120000 }, (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function getLibreOfficeCommand() {
    const configuredPath = process.env.SOFFICE_PATH;
    const fileCandidates = [
        configuredPath,
        process.platform === 'win32' ? path.join(process.env.ProgramFiles || '', 'LibreOffice', 'program', 'soffice.exe') : null,
        process.platform === 'win32' ? path.join(process.env['ProgramFiles(x86)'] || '', 'LibreOffice', 'program', 'soffice.exe') : null
    ].filter(Boolean);

    const fileCommand = fileCandidates.find(candidate => fs.existsSync(candidate));
    if (fileCommand) return fileCommand;

    const lookupCommand = process.platform === 'win32' ? 'where.exe' : 'which';
    for (const command of ['soffice', 'libreoffice']) {
        try {
            execFileSync(lookupCommand, [command], { stdio: 'ignore' });
            return command;
        } catch (lookupError) {
            // Try the next executable name.
        }
    }

    throw new Error('LibreOffice tidak ditemukan. Install LibreOffice atau set environment variable SOFFICE_PATH ke lokasi soffice.exe.');
}

async function convertLegacyDocToDocx(inputPath, outputDir) {
    const convertedPath = path.join(outputDir, `${path.basename(inputPath, path.extname(inputPath))}.docx`);
    await runCommand(getLibreOfficeCommand(), ['--headless', '--norestore', '--nofirststartwizard', '--convert-to', 'docx', '--outdir', outputDir, inputPath]);
    if (!fs.existsSync(convertedPath)) {
        throw new Error('LibreOffice tidak menghasilkan file DOCX.');
    }
    return convertedPath;
}

async function convertDocxToLegacyDoc(inputPath, outputDir) {
    const convertedPath = path.join(outputDir, `${path.basename(inputPath, path.extname(inputPath))}.doc`);
    const command = getLibreOfficeCommand();
    const commonArgs = ['--headless', '--norestore', '--nofirststartwizard', '--outdir', outputDir, inputPath];
    await runCommand(command, [...commonArgs.slice(0, 3), '--convert-to', 'doc:MS Word 97', ...commonArgs.slice(3)]);
    if (!fs.existsSync(convertedPath)) {
        await runCommand(command, [...commonArgs.slice(0, 3), '--convert-to', 'doc', ...commonArgs.slice(3)]);
    }
    if (!fs.existsSync(convertedPath)) {
        throw new Error('LibreOffice tidak menghasilkan file DOC.');
    }
    return convertedPath;
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

// Endpoint Upload DOC/DOCX -> HTML
app.post('/api/upload', (req, res) => {
    if (!req.files || !req.files.document) return res.status(400).send('Tidak ada file yang diunggah.');

    const file = req.files.document;
    const time = Date.now();
    const originalExtension = path.extname(file.name).toLowerCase();
    if (!['.doc', '.docx'].includes(originalExtension)) {
        return res.status(400).send('Format file harus DOC atau DOCX.');
    }

    const inputPath = path.join(__dirname, 'uploads', `input_${time}${originalExtension}`);
    const inputDocxPath = path.join(__dirname, 'uploads', `input_${time}.docx`);
    const inputHtmlPath = path.join(__dirname, 'uploads', `input_${time}.html`);
    const outputPath = path.join(__dirname, 'uploads', `output_${time}.html`);
    const mediaDir = path.join(__dirname, 'uploads', `media_${time}`);

    fs.ensureDirSync(mediaDir);

    file.mv(inputPath, (err) => {
        if (err) return res.status(500).send('Gagal memindahkan file sementara.');

        (async () => {
            try {
                const isHtmlBasedDoc = originalExtension === '.doc'
                    && extractConfluenceHtmlDoc(inputPath, mediaDir, inputHtmlPath);

                if (isHtmlBasedDoc) {
                    fs.copyFileSync(inputHtmlPath, outputPath);
                } else {
                    const docxPath = originalExtension === '.doc'
                        ? await convertLegacyDocToDocx(inputPath, path.dirname(inputPath))
                        : inputPath;
                    await runCommand('pandoc', [docxPath, '-f', 'docx', '-t', 'html', `--extract-media=${mediaDir}`, '-o', outputPath]);
                }

                let htmlContent = fs.readFileSync(outputPath, 'utf8');
                if (!isHtmlBasedDoc) htmlContent = processExtractedMedia(mediaDir, htmlContent);

                res.json({ html: htmlContent });
            } catch (err) {
                console.error('Upload conversion error:', err.stderr || err.message);
                const missingLibreOffice = err.message.includes('LibreOffice tidak ditemukan') || err.code === 'ENOENT';
                res.status(missingLibreOffice ? 503 : 500).send(missingLibreOffice
                    ? 'File DOC membutuhkan LibreOffice. Install LibreOffice terlebih dahulu atau jalankan aplikasi melalui Docker.'
                    : 'Gagal mengonversi file DOC/DOCX ke HTML.');
            } finally {
                fs.removeSync(inputPath);
                fs.removeSync(inputDocxPath);
                fs.removeSync(inputHtmlPath);
                fs.removeSync(outputPath);
                fs.removeSync(mediaDir);
            }
        })();
    });
});

// Endpoint Download HTML -> DOC/DOCX
app.post('/api/download', (req, res) => {
    const { htmlContent, format = 'docx' } = req.body;
    if (!htmlContent) return res.status(400).send('Konten dokumen kosong.');
    if (!['doc', 'docx'].includes(format)) return res.status(400).send('Format download tidak valid.');

    const time = Date.now();
    const tempHtmlPath = path.join(__dirname, 'uploads', `temp_${time}.html`);
    const outputDocxPath = path.join(__dirname, 'uploads', `Document_${time}.docx`);
    const outputDirectory = path.join(__dirname, 'uploads', `download_${time}`);
    fs.ensureDirSync(outputDirectory);

    // Enhance table dengan inline CSS style yang explicit untuk border rendering di DOCX
    let enhancedHtml = normalizeCssColors(htmlContent);
    const downloadMediaDir = path.join(__dirname, 'uploads', `download_media_${time}`);
    fs.ensureDirSync(downloadMediaDir);
    enhancedHtml = materializeEmbeddedImages(enhancedHtml, downloadMediaDir);
    
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

    (async () => {
        try {
            const pandocArgs = [tempHtmlPath, '-f', 'html', '-t', 'docx'];
            const referenceDocxPath = getReferenceDocxPath();
            if (referenceDocxPath) pandocArgs.push(`--reference-doc=${referenceDocxPath}`);
            pandocArgs.push('-o', outputDocxPath);
            await runCommand('pandoc', pandocArgs);
            await applyWordTableGrid(outputDocxPath);
            await applyHtmlFontColors(outputDocxPath, enhancedHtml);

            const outputPath = format === 'docx'
                ? outputDocxPath
                : await convertDocxToLegacyDoc(outputDocxPath, outputDirectory);
            const downloadName = `Dokumen_Arsitektur_Update.${format}`;

            res.download(outputPath, downloadName, (downloadErr) => {
                if (downloadErr) console.error('Download Error:', downloadErr);
                fs.removeSync(tempHtmlPath);
                fs.removeSync(outputDocxPath);
                fs.removeSync(outputDirectory);
                fs.removeSync(downloadMediaDir);
            });
        } catch (borderErr) {
            console.error('Download conversion error:', borderErr.stderr || borderErr.message);
            fs.removeSync(tempHtmlPath);
            fs.removeSync(outputDocxPath);
            fs.removeSync(outputDirectory);
            fs.removeSync(downloadMediaDir);
            const missingLibreOffice = borderErr.message.includes('LibreOffice tidak ditemukan') || borderErr.code === 'ENOENT';
            return res.status(missingLibreOffice ? 503 : 500).send(missingLibreOffice
                ? 'Download DOC membutuhkan LibreOffice. Gunakan Docker/Koyeb atau install LibreOffice di komputer lokal.'
                : 'Gagal membuat file DOC/DOCX.');
        }
    })();
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
}

module.exports = app;