const express = require('express');
const fileUpload = require('express-fileupload');
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

const app = express();
const PORT = process.env.PORT || 3000;

// AUTO-INSTALL PANDOC
try {
    execSync('pandoc --version', { stdio: 'ignore' });
    console.log('✅ Pandoc sudah terinstal dan siap digunakan.');
} catch (error) {
    console.log('⏳ Pandoc belum terinstal! Sedang menginstal otomatis...');
    try {
        execSync('sudo apt-get update && sudo apt-get install -y pandoc', { stdio: 'inherit' });
        console.log('✅ Pandoc berhasil diinstal!');
    } catch (installError) {
        console.error('❌ Gagal otomatis instal Pandoc.');
    }
}

app.use(express.static('public'));
// Kapasitas body parser diperbesar hingga 500mb untuk mengakomodir gambar Base64 resolusi tinggi
app.use(express.json({ limit: '500mb' })); 
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(fileUpload({ limits: { fileSize: 500 * 1024 * 1024 } })); // Limit file upload 500MB

fs.ensureDirSync(path.join(__dirname, 'uploads'));

// 1. Endpoint Upload .docx -> Convert to HTML using Pandoc
app.post('/api/upload', (req, res) => {
    if (!req.files || !req.files.document) {
        return res.status(400).send('Tidak ada file yang diunggah.');
    }

    const file = req.files.document;
    const time = Date.now();
    const inputPath = path.join(__dirname, 'uploads', `input_${time}.docx`);
    const outputPath = path.join(__dirname, 'uploads', `output_${time}.html`);

    file.mv(inputPath, (err) => {
        if (err) return res.status(500).send(err);

        // Menggunakan flag --embed-resources --standalone sebagai standar modern pengganti --self-contained
        exec(`pandoc "${inputPath}" -f docx -t html --embed-resources --standalone -o "${outputPath}"`, (execErr) => {
            if (execErr) {
                console.error('Error saat konversi HTML:', execErr);
                return res.status(500).send('Gagal mengonversi file Word ke HTML.');
            }

            const htmlContent = fs.readFileSync(outputPath, 'utf8');
            fs.removeSync(inputPath);
            fs.removeSync(outputPath);

            res.json({ html: htmlContent });
        });
    });
});

// 2. Endpoint Download HTML -> Convert back to .docx
app.post('/api/download', (req, res) => {
    const { htmlContent } = req.body;
    if (!htmlContent) return res.status(400).send('Konten dokumen kosong.');

    const time = Date.now();
    const tempHtmlPath = path.join(__dirname, 'uploads', `temp_${time}.html`);
    const outputDocxPath = path.join(__dirname, 'uploads', `Document_${time}.docx`);

    const fullHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
          td, th { border: 1px solid #000; padding: 6px; vertical-align: top; }
          th { background-color: #f2f2f2; }
          img { max-width: 100%; height: auto; }
        </style>
      </head>
      <body>${htmlContent}</body>
      </html>
    `;

    fs.writeFileSync(tempHtmlPath, fullHtml);

    exec(`pandoc "${tempHtmlPath}" -f html -t docx -o "${outputDocxPath}"`, (execErr) => {
        if (execErr) {
            console.error('Error saat konversi DOCX:', execErr);
            return res.status(500).send('Gagal mengonversi HTML ke Word.');
        }

        res.download(outputDocxPath, 'Dokumen_Arsitektur_Updated.docx', () => {
            fs.removeSync(tempHtmlPath);
            fs.removeSync(outputDocxPath);
        });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di port ${PORT}`);
});