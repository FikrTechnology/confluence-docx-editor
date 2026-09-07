const express = require('express');
const fileUpload = require('express-fileupload');
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

const app = express();
const PORT = process.env.PORT || 3000;

// AUTO-INSTALL DEPENDENCIES
try {
    execSync('pandoc --version', { stdio: 'ignore' });
} catch (error) {
    console.log('⏳ Sedang menginstal dependensi (Pandoc & ImageMagick)...');
    try {
        execSync('sudo apt-get update && sudo apt-get install -y pandoc imagemagick', { stdio: 'ignore' });
        console.log('✅ Dependensi berhasil diinstal!');
    } catch (installError) {
        console.error('❌ Gagal menginstal otomatis. Pastikan Pandoc dan Imagemagick tersedia.');
    }
}

app.use(express.static('public'));
app.use(express.json({ limit: '500mb' })); 
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(fileUpload({ limits: { fileSize: 500 * 1024 * 1024 } })); 

fs.ensureDirSync(path.join(__dirname, 'uploads'));

// PERBAIKAN: Fungsi untuk mencari SEMUA file gambar secara mendalam (Rekursif)
// Karena pandoc biasanya membuat sub-folder otomatis (contoh: media/image1.png)
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
        // Ambil semua file di dalam folder media secara rekursif
        const allFiles = getAllFilesRecursive(mediaDir);
        
        allFiles.forEach(filePath => {
            let file = path.basename(filePath);
            let ext = path.extname(file).toLowerCase();
            let originalName = file;

            // KONVERSI Vektor (EMF/WMF) ke PNG
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

            // Baca file gambar ke Base64
            if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
                try {
                    const imageBuffer = fs.readFileSync(filePath);
                    const base64Data = imageBuffer.toString('base64');
                    const mimeType = ext === '.svg' ? 'image/svg+xml' : `image/${ext.replace('.', '')}`;
                    const dataUrl = `data:${mimeType};base64,${base64Data}`;

                    // PERBAIKAN: Regex yang lebih tahan banting untuk mereplace src pada HTML
                    // Pandoc kadang menulis path sebagai src="media/image1.jpeg"
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

// 1. Endpoint Upload 
app.post('/api/upload', (req, res) => {
    if (!req.files || !req.files.document) return res.status(400).send('Tidak ada file.');

    const file = req.files.document;
    const time = Date.now();
    const inputPath = path.join(__dirname, 'uploads', `input_${time}.docx`);
    const outputPath = path.join(__dirname, 'uploads', `output_${time}.html`);
    const mediaDir = path.join(__dirname, 'uploads', `media_${time}`);

    fs.ensureDirSync(mediaDir);

    file.mv(inputPath, (err) => {
        if (err) return res.status(500).send('Gagal memindahkan file.');

        exec(`pandoc "${inputPath}" -f docx -t html --extract-media="${mediaDir}" -o "${outputPath}"`, (execErr) => {
            if (execErr) {
                console.error('Pandoc Error:', execErr);
                return res.status(500).send('Gagal konversi HTML.');
            }

            try {
                let htmlContent = fs.readFileSync(outputPath, 'utf8');
                // Panggil proses konversi gambar ke Base64
                htmlContent = processExtractedMedia(mediaDir, htmlContent);

                res.json({ html: htmlContent });
            } catch (err) {
                console.error('File Read Error:', err);
                res.status(500).send('Terjadi kesalahan pembacaan output.');
            } finally {
                // Pembersihan file temporer (Jangan lupa dibersihkan agar server tidak penuh)
                fs.removeSync(inputPath);
                fs.removeSync(outputPath);
                fs.removeSync(mediaDir);
            }
        });
    });
});

// 2. Endpoint Download 
app.post('/api/download', (req, res) => {
    const { htmlContent } = req.body;
    if (!htmlContent) return res.status(400).send('Konten kosong.');

    const time = Date.now();
    const tempHtmlPath = path.join(__dirname, 'uploads', `temp_${time}.html`);
    const outputDocxPath = path.join(__dirname, 'uploads', `Document_${time}.docx`);

    const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${htmlContent}</body></html>`;
    fs.writeFileSync(tempHtmlPath, fullHtml);

    exec(`pandoc "${tempHtmlPath}" -f html -t docx -o "${outputDocxPath}"`, (execErr) => {
        if (execErr) return res.status(500).send('Gagal konversi ke DOCX.');

        res.download(outputDocxPath, 'Dokumen_Update.docx', () => {
            fs.removeSync(tempHtmlPath);
            fs.removeSync(outputDocxPath);
        });
    });
});

app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));