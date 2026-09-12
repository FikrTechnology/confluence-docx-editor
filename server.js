const express = require('express');
const fileUpload = require('express-fileupload');
const {
  execFile,
  execFileSync
} = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const {
  pathToFileURL
} = require('url');

const app = express();

const PORT =
  process.env.PORT || 3000;

const UPLOAD_ROOT =
  path.join(
    __dirname,
    'uploads'
  );

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);

app.use(
  express.json({
    limit: '500mb'
  })
);

app.use(
  express.urlencoded({
    limit: '500mb',
    extended: true
  })
);

app.use(
  fileUpload({
    limits: {
      fileSize:
        500 * 1024 * 1024
    }
  })
);

fs.ensureDirSync(
  UPLOAD_ROOT
);

function getAllFilesRecursive(
  dirPath,
  result = []
) {

  if (
    !fs.existsSync(
      dirPath
    )
  ) {
    return result;
  }

  for (
    const name of fs.readdirSync(
      dirPath
    )
  ) {

    const full =
      path.join(
        dirPath,
        name
      );

    const stat =
      fs.statSync(
        full
      );

    if (
      stat.isDirectory()
    ) {

      getAllFilesRecursive(
        full,
        result
      );

    } else {

      result.push(
        full
      );
    }
  }

  return result;
}

function contentTypeFromPath(
  filePath
) {

  const ext =
    path.extname(
      filePath
    ).toLowerCase();

  return {
    '.png':
      'image/png',

    '.jpg':
      'image/jpeg',

    '.jpeg':
      'image/jpeg',

    '.gif':
      'image/gif',

    '.svg':
      'image/svg+xml',

    '.webp':
      'image/webp',

    '.bmp':
      'image/bmp',

    '.ico':
      'image/x-icon'
  }[ext] ||
    'application/octet-stream';
}

function getLibreOfficeCommand() {

  const configured =
    process.env.SOFFICE_PATH;

  const candidates = [
    configured,

    process.platform ===
      'win32' &&
    process.env.ProgramFiles
      ? path.join(
          process.env.ProgramFiles,
          'LibreOffice',
          'program',
          'soffice.com'
        )
      : null,

    process.platform ===
      'win32' &&
    process.env.ProgramFiles
      ? path.join(
          process.env.ProgramFiles,
          'LibreOffice',
          'program',
          'soffice.exe'
        )
      : null,

    process.platform ===
      'win32' &&
    process.env[
      'ProgramFiles(x86)'
    ]
      ? path.join(
          process.env[
            'ProgramFiles(x86)'
          ],
          'LibreOffice',
          'program',
          'soffice.com'
        )
      : null,

    process.platform ===
      'win32' &&
    process.env[
      'ProgramFiles(x86)'
    ]
      ? path.join(
          process.env[
            'ProgramFiles(x86)'
          ],
          'LibreOffice',
          'program',
          'soffice.exe'
        )
      : null
  ].filter(Boolean);

  const existing =
    candidates.find(
      filePath =>
        fs.existsSync(
          filePath
        )
    );

  if (existing) {
    return existing;
  }

  const lookup =
    process.platform ===
    'win32'
      ? 'where.exe'
      : 'which';

  for (
    const name of [
      'soffice.com',
      'soffice',
      'libreoffice'
    ]
  ) {

    try {

      const output =
        execFileSync(
          lookup,
          [name],
          {
            encoding: 'utf8'
          }
        ).trim();

      if (output) {

        return output
          .split(/\r?\n/)[0]
          .trim();
      }

    } catch (_) {}
  }

  throw new Error(
    'LibreOffice tidak ditemukan. Install LibreOffice atau set SOFFICE_PATH.'
  );
}

function createLibreOfficeProfile() {

  const profileDir =
    path.join(
      UPLOAD_ROOT,
      `lo_profile_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 12)}`
    );

  fs.ensureDirSync(
    profileDir
  );

  return profileDir;
}

function runCommand(
  command,
  args,
  options = {}
) {

  return new Promise(
    (resolve, reject) => {

      execFile(
        command,
        args,
        {
          timeout:
            options.timeout ||
            180000,

          maxBuffer:
            options.maxBuffer ||
            100 *
              1024 *
              1024,

          windowsHide:
            true
        },

        (
          error,
          stdout,
          stderr
        ) => {

          if (error) {

            error.stdout =
              stdout || '';

            error.stderr =
              stderr || '';

            reject(error);

            return;
          }

          resolve({
            stdout:
              stdout || '',

            stderr:
              stderr || ''
          });
        }
      );
    }
  );
}

async function convertWithLibreOffice(
  inputPath,
  outputDir,
  filter
) {

  fs.ensureDirSync(
    outputDir
  );

  const soffice =
    getLibreOfficeCommand();

  const profileDir =
    createLibreOfficeProfile();

  /*
   * Jangan menggunakan:
   *
   * -env\:UserInstallation=
   *
   * Gunakan file URL asli.
   */
  const profileUrl =
    pathToFileURL(
      profileDir
    ).href;

  const args = [
    `-env:UserInstallation=${profileUrl}`,

    '--headless',

    '--nologo',

    '--nodefault',

    '--nofirststartwizard',

    '--norestore',

    '--nolockcheck',

    '--convert-to',

    filter,

    '--outdir',

    outputDir,

    inputPath
  ];

  try {

    const result =
      await runCommand(
        soffice,
        args
      );

    const outputName =
      path.basename(
        inputPath,
        path.extname(
          inputPath
        )
      );

    const extension =
      filter.startsWith(
        'html'
      )
        ? '.html'
        : filter.startsWith(
            'docx'
          )
        ? '.docx'
        : filter.startsWith(
            'doc:'
          )
        ? '.doc'
        : '';

    const expected =
      extension
        ? path.join(
            outputDir,
            outputName +
              extension
          )
        : null;

    if (
      expected &&
      fs.existsSync(
        expected
      )
    ) {

      return expected;
    }

    const generated =
      getAllFilesRecursive(
        outputDir
      ).filter(
        filePath => {

          const ext =
            path.extname(
              filePath
            ).toLowerCase();

          return filter.startsWith(
            'html'
          )
            ? [
                '.html',
                '.htm',
                '.xhtml'
              ].includes(ext)

            : filter.startsWith(
                'docx'
              )
            ? ext === '.docx'

            : filter.startsWith(
                'doc:'
              )
            ? ext === '.doc'

            : false;
        }
      );

    if (
      !generated.length
    ) {

      const detail = [
        result.stdout,
        result.stderr
      ]
        .filter(Boolean)
        .join('\n')
        .trim();

      throw new Error(
        `LibreOffice tidak menghasilkan file output.${
          detail
            ? `\n${detail}`
            : ''
        }`
      );
    }

    return generated[0];

  } catch (error) {

    const detail = [
      error.message,
      error.stderr,
      error.stdout
    ]
      .filter(Boolean)
      .join('\n')
      .trim();

    const wrapped =
      new Error(
        `LibreOffice gagal menjalankan konversi.\n${detail}`
      );

    wrapped.stderr =
      error.stderr || '';

    wrapped.stdout =
      error.stdout || '';

    wrapped.code =
      error.code;

    throw wrapped;

  } finally {

    fs.removeSync(
      profileDir
    );
  }
}

function decodeQuotedPrintable(
  value
) {

  return value
    .replace(
      /=\r?\n/g,
      ''
    )
    .replace(
      /=([a-f0-9]{2})/gi,
      (_, hex) =>
        String.fromCharCode(
          parseInt(
            hex,
            16
          )
        )
    );
}

function parseMimeHeaders(
  headerText
) {

  const headers = {};

  headerText
    .split(/\r?\n/)
    .forEach(
      line => {

        const index =
          line.indexOf(':');

        if (index > 0) {

          headers[
            line
              .slice(
                0,
                index
              )
              .trim()
              .toLowerCase()
          ] =
            line
              .slice(
                index + 1
              )
              .trim();
        }
      }
    );

  return headers;
}

function extractConfluenceHtmlDoc(
  inputPath,
  mediaDir,
  outputPath
) {

  const raw =
    fs.readFileSync(
      inputPath
    );

  const text =
    raw.toString(
      'utf8'
    );

  const isMimeExport =
    /multipart\/related/i.test(
      text
    ) &&
    /<html[\s>]/i.test(
      text
    );

  if (
    !isMimeExport &&
    !/<html[\s>]/i.test(
      text
    )
  ) {

    return false;
  }

  let htmlContent =
    text;

  if (isMimeExport) {

    const boundaryMatch =
      text.match(
        /boundary\s*=\s*(?:"([^"]+)"|([^;\r\n]+))/i
      );

    if (
      !boundaryMatch
    ) {

      throw new Error(
        'Boundary MIME pada file DOC tidak ditemukan.'
      );
    }

    const boundary =
      boundaryMatch[1] ||
      boundaryMatch[2];

    const parts =
      text.split(
        `--${boundary}`
      );

    const imageReferences =
      [];

    for (
      const part of parts
    ) {

      const separator =
        part.search(
          /\r?\n\r?\n/
        );

      if (
        separator < 0
      ) {
        continue;
      }

      const headerText =
        part.slice(
          0,
          separator
        );

      const body =
        part
          .slice(separator)
          .replace(
            /^\r?\n\r?\n/,
            ''
          )
          .replace(
            /\r?\n--$/,
            ''
          );

      const headers =
        parseMimeHeaders(
          headerText
        );

      const contentType =
        (
          headers[
            'content-type'
          ] || ''
        )
          .split(';')[0]
          .toLowerCase();

      const transferEncoding =
        (
          headers[
            'content-transfer-encoding'
          ] || ''
        ).toLowerCase();

      if (
        contentType ===
        'text/html'
      ) {

        htmlContent =
          transferEncoding ===
          'quoted-printable'
            ? decodeQuotedPrintable(
                body
              )
            : body;

        continue;
      }

      if (
        contentType.startsWith(
          'image/'
        ) ||
        contentType ===
          'application/octet-stream'
      ) {

        const extension =
          contentType.startsWith(
            'image/'
          )
            ? contentType
                .split('/')[1]
                .replace(
                  'svg+xml',
                  'svg'
                )
                .replace(
                  'jpeg',
                  'jpg'
                )
            : 'png';

        const imagePath =
          path.join(
            mediaDir,
            `embedded_${imageReferences.length}.${extension}`
          );

        const imageBuffer =
          transferEncoding ===
          'base64'
            ? Buffer.from(
                body.replace(
                  /\s/g,
                  ''
                ),
                'base64'
              )
            : Buffer.from(
                body,
                'binary'
              );

        fs.writeFileSync(
          imagePath,
          imageBuffer
        );

        imageReferences.push({
          imagePath,

          contentLocation:
            headers[
              'content-location'
            ] || '',

          contentId:
            (
              headers[
                'content-id'
              ] || ''
            ).replace(
              /[<>]/g,
              ''
            )
        });
      }
    }

    imageReferences.forEach(
      ({
        imagePath,
        contentLocation,
        contentId
      }) => {

        const dataUrl =
          `data:${contentTypeFromPath(
            imagePath
          )};base64,` +
          fs
            .readFileSync(
              imagePath
            )
            .toString(
              'base64'
            );

        const keys = [
          contentLocation,
          contentId,
          path.basename(
            contentLocation ||
              ''
          )
        ].filter(
          Boolean
        );

        keys.forEach(
          key => {

            const escaped =
              key.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
              );

            htmlContent =
              htmlContent.replace(
                new RegExp(
                  `(src=["'])${escaped}(["'])`,
                  'gi'
                ),
                `$1${dataUrl}$2`
              );
          }
        );
      }
    );
  }

  fs.writeFileSync(
    outputPath,
    htmlContent,
    'utf8'
  );

  return true;
}

function inlineLocalImages(
  htmlContent,
  htmlFilePath
) {

  const htmlDir =
    path.dirname(
      htmlFilePath
    );

  return htmlContent.replace(
    /(<img\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'])/gi,

    (
      match,
      prefix,
      src,
      suffix
    ) => {

      if (
        !src ||
        /^data:/i.test(src) ||
        /^https?:\/\//i.test(src) ||
        /^blob:/i.test(src)
      ) {

        return match;
      }

      try {

        let cleanSrc =
          src
            .replace(
              /&amp;/g,
              '&'
            )
            .replace(
              /&#x20;/gi,
              ' '
            );

        if (
          /^file:\/\//i.test(
            cleanSrc
          )
        ) {

          cleanSrc =
            new URL(
              cleanSrc
            )
              .pathname
              .replace(
                /^\/+/,
                ''
              );

          if (
            process.platform ===
              'win32' &&
            /^[A-Za-z]:/.test(
              cleanSrc
            )
          ) {

            cleanSrc =
              cleanSrc.replace(
                /^\/+/,
                ''
              );
          }
        }

        const localPath =
          path.resolve(
            htmlDir,
            decodeURIComponent(
              cleanSrc
            )
          );

        if (
          !fs.existsSync(
            localPath
          ) ||
          !fs.statSync(
            localPath
          ).isFile()
        ) {

          return match;
        }

        const dataUrl =
          `data:${contentTypeFromPath(
            localPath
          )};base64,` +
          fs
            .readFileSync(
              localPath
            )
            .toString(
              'base64'
            );

        return (
          prefix +
          dataUrl +
          suffix
        );

      } catch (_) {

        return match;
      }
    }
  );
}

function extractBody(
  htmlContent
) {

  const bodyMatch =
    htmlContent.match(
      /<body\b[^>]*>([\s\S]*?)<\/body>/i
    );

  return bodyMatch
    ? bodyMatch[1]
    : htmlContent;
}

function buildCssClassMap(
  htmlContent
) {

  const cssBlocks = [
    ...htmlContent.matchAll(
      /<style\b[^>]*>([\s\S]*?)<\/style>/gi
    )
  ]
    .map(
      match =>
        match[1]
    )
    .join('\n');

  const map =
    new Map();

  const ruleRegex =
    /([^{}]+)\{([^{}]*)\}/g;

  let rule;

  while (
    (rule =
      ruleRegex.exec(
        cssBlocks
      ))
  ) {

    const selectorText =
      rule[1];

    const declarations =
      rule[2].trim();

    if (
      !declarations
    ) {
      continue;
    }

    for (
      const selector of
      selectorText.split(',')
    ) {

      if (
        selector.includes(':') ||
        selector.includes('@')
      ) {
        continue;
      }

      const classes = [
        ...selector.matchAll(
          /\.([A-Za-z_][\w-]*)/g
        )
      ].map(
        match =>
          match[1]
      );

      classes.forEach(
        cls => {

          const current =
            map.get(cls) ||
            '';

          map.set(
            cls,
            current
              ? `${current};${declarations}`
              : declarations
          );
        }
      );
    }
  }

  return map;
}

function inlineCssClassStyles(
  htmlContent
) {

  const classMap =
    buildCssClassMap(
      htmlContent
    );

  if (
    !classMap.size
  ) {

    return extractBody(
      htmlContent
    );
  }

  const body =
    extractBody(
      htmlContent
    );

  return body.replace(
    /<([A-Za-z][\w:-]*)(\s[^<>]*?)?>/g,

    (
      match,
      tagName,
      attrs = ''
    ) => {

      const classMatch =
        attrs.match(
          /\bclass\s*=\s*(["'])(.*?)\1/i
        );

      if (
        !classMatch
      ) {

        return match;
      }

      const classes =
        classMatch[2].match(
          /[A-Za-z_][\w-]*/g
        ) || [];

      const classStyles =
        classes
          .map(
            cls =>
              classMap.get(
                cls
              )
          )
          .filter(
            Boolean
          );

      if (
        !classStyles.length
      ) {

        return match;
      }

      const styleMatch =
        attrs.match(
          /\bstyle\s*=\s*(["'])(.*?)\1/i
        );

      const existingStyle =
        styleMatch
          ? styleMatch[2].trim()
          : '';

      const mergedStyle = [
        existingStyle,
        ...classStyles
      ]
        .filter(Boolean)
        .join(';');

      if (
        styleMatch
      ) {

        const newAttrs =
          attrs.slice(
            0,
            styleMatch.index
          ) +

          `style="${mergedStyle.replace(
            /"/g,
            '&quot;'
          )}"` +

          attrs.slice(
            styleMatch.index +
              styleMatch[0].length
          );

        return `<${tagName}${newAttrs}>`;
      }

      return `<${tagName}${attrs} style="${mergedStyle.replace(
        /"/g,
        '&quot;'
      )}">`;
    }
  );
}

/*
 * LibreOffice HTML menggunakan <strike>
 * untuk format strikethrough.
 *
 * Untuk menghindari TinyMCE menghilangkannya,
 * kita ubah menjadi:
 *
 * <span style="text-decoration: line-through">
 */
function normalizeStrikethrough(
  htmlContent
) {

  return htmlContent.replace(
    /<\/?(strike|s|del)\b[^>]*>/gi,

    match => {

      if (
        /^<\//.test(
          match
        )
      ) {

        return '</span>';
      }

      const attrs =
        match
          .replace(
            /^<[^\s>]+/i,
            ''
          )
          .replace(
            /\/>$/i,
            ''
          )
          .replace(
            />$/i,
            ''
          )
          .trim();

      const styleMatch =
        attrs.match(
          /\bstyle\s*=\s*(["'])(.*?)\1/i
        );

      let style =
        styleMatch
          ? styleMatch[2].trim()
          : '';

      if (
        !/text-decoration\s*:/i.test(
          style
        )
      ) {

        style =
          `${style}${
            style ? ';' : ''
          }text-decoration: line-through`;

      } else {

        style =
          style.replace(
            /text-decoration\s*:[^;]*/gi,
            'text-decoration: line-through'
          );
      }

      const otherAttrs =
        attrs
          .replace(
            /\bstyle\s*=\s*(["'])(.*?)\1/gi,
            ''
          )
          .trim();

      return (
        `<span${
          otherAttrs
            ? ` ${otherAttrs}`
            : ''
        } style="${style.replace(
          /"/g,
          '&quot;'
        )}">`
      );
    }
  );
}

function prepareEditorHtml(
  htmlContent,
  htmlFilePath
) {

  /*
   * Pertahankan warna text.
   *
   * HTML StarWriter menggunakan:
   *
   * <font color="#ff0000">
   *
   * dan sebagian versi menggunakan CSS class.
   */

  let prepared =
    inlineLocalImages(
      htmlContent,
      htmlFilePath
    );

  prepared =
    inlineCssClassStyles(
      prepared
    );

  /*
   * FIX STRIKETHROUGH
   */
  prepared =
    normalizeStrikethrough(
      prepared
    );

  prepared =
    prepared
      .replace(
        /<script\b[\s\S]*?<\/script>/gi,
        ''
      )
      .replace(
        /\scontenteditable\s*=\s*["'][^"']*["']/gi,
        ''
      )
      .replace(
        /\sdata-mce-[\w-]+\s*=\s*["'][^"']*["']/gi,
        ''
      );

  return prepared;
}

function sanitizeHtmlForLibreOffice(
  htmlContent
) {

  return htmlContent
    .replace(
      /<script\b[\s\S]*?<\/script>/gi,
      ''
    )
    .replace(
      /\scontenteditable\s*=\s*["'][^"']*["']/gi,
      ''
    )
    .replace(
      /\sdata-mce-[\w-]+\s*=\s*["'][^"']*["']/gi,
      ''
    )
    .replace(
      /\sdata-mce-style\s*=\s*["'][^"']*["']/gi,
      ''
    )
    .replace(
      /<meta[^>]*name=["']generator["'][^>]*>/gi,
      ''
    )
    .replace(
      /\sclass=["']mce-[^"']*["']/gi,
      ''
    );
}

function cleanupPaths(
  paths
) {

  for (
    const item of paths
  ) {

    if (!item) {
      continue;
    }

    try {

      fs.removeSync(
        item
      );

    } catch (_) {}
  }
}

app.post(
  '/api/upload',
  async (req, res) => {

    if (
      !req.files ||
      !req.files.document
    ) {

      return res
        .status(400)
        .send(
          'Tidak ada file yang diunggah.'
        );
    }

    const file =
      req.files.document;

    const extension =
      path.extname(
        file.name
      ).toLowerCase();

    if (
      ![
        '.docx',
        '.doc'
      ].includes(
        extension
      )
    ) {

      return res
        .status(400)
        .send(
          'Format file harus DOCX atau DOC.'
        );
    }

    const requestDir =
      path.join(
        UPLOAD_ROOT,
        `request_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 10)}`
      );

    const inputPath =
      path.join(
        requestDir,
        `input${extension}`
      );

    const htmlDir =
      path.join(
        requestDir,
        'html'
      );

    const mediaDir =
      path.join(
        requestDir,
        'media'
      );

    const temporaryDocxDir =
      path.join(
        requestDir,
        'converted_docx'
      );

    fs.ensureDirSync(
      htmlDir
    );

    fs.ensureDirSync(
      mediaDir
    );

    fs.ensureDirSync(
      temporaryDocxDir
    );

    try {

      await file.mv(
        inputPath
      );

      let sourceDocx =
        inputPath;

      const confluenceHtmlPath =
        path.join(
          htmlDir,
          'confluence.html'
        );

      const isConfluenceHtmlDoc =
        extension === '.doc' &&
        extractConfluenceHtmlDoc(
          inputPath,
          mediaDir,
          confluenceHtmlPath
        );

      let htmlPath;

      if (
        isConfluenceHtmlDoc
      ) {

        htmlPath =
          confluenceHtmlPath;

      } else {

        if (
          extension === '.doc'
        ) {

          sourceDocx =
            await convertWithLibreOffice(
              inputPath,
              temporaryDocxDir,
              'docx:Office Open XML Text'
            );
        }

        /*
         * PENTING:
         *
         * Jangan kembali ke Pandoc.
         *
         * HTML (StarWriter) mempertahankan:
         * - warna text
         * - <strike>
         * - underline
         * - struktur ul/li
         * - image references
         */

        htmlPath =
          await convertWithLibreOffice(
            sourceDocx,
            htmlDir,
            'html:HTML (StarWriter)'
          );
      }

      const rawHtml =
        fs.readFileSync(
          htmlPath,
          'utf8'
        );

      const editorHtml =
        prepareEditorHtml(
          rawHtml,
          htmlPath
        );

      return res.json({
        html:
          editorHtml
      });

    } catch (error) {

      console.error(
        'Upload conversion error:',
        error.stderr ||
          error.message
      );

      return res
        .status(500)
        .send(
          `Gagal mengonversi file Word ke HTML.\n\n${
            error.stderr ||
            error.message ||
            'Unknown error'
          }`
        );

    } finally {

      cleanupPaths([
        requestDir
      ]);
    }
  }
);

app.post(
  '/api/download',
  async (req, res) => {

    const {
      htmlContent,
      format = 'docx',
      fileName
    } =
      req.body || {};

    if (!htmlContent) {

      return res
        .status(400)
        .send(
          'Konten dokumen kosong.'
        );
    }

    if (
      ![
        'docx',
        'doc'
      ].includes(
        format
      )
    ) {

      return res
        .status(400)
        .send(
          'Format download tidak valid.'
        );
    }

    const safeName =
      (
        fileName ||
        'Dokumen_Arsitektur_Update'
      )
        .replace(
          /[\\/:*?"<>|]/g,
          ''
        )
        .trim() ||
      'Dokumen_Arsitektur_Update';

    const requestDir =
      path.join(
        UPLOAD_ROOT,
        `download_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 10)}`
      );

    const htmlInputPath =
      path.join(
        requestDir,
        'edited.html'
      );

    const docxOutputDir =
      path.join(
        requestDir,
        'docx'
      );

    const finalDocPath =
      path.join(
        requestDir,
        'doc'
      );

    fs.ensureDirSync(
      requestDir
    );

    fs.ensureDirSync(
      docxOutputDir
    );

    try {

      /*
       * Jangan mengubah data:image/... menjadi
       * relative path.
       *
       * Frontend sudah memastikan blob:
       * dikonversi menjadi data:image/... URL.
       *
       * LibreOffice akan meng-embed data URL
       * ke dalam DOCX.
       */
      let html =
        sanitizeHtmlForLibreOffice(
          htmlContent
        );

      /*
       * FIX STRIKETHROUGH:
       *
       * Jika masih ada <strike>, ubah ke
       * inline text-decoration sebelum
       * masuk LibreOffice.
       */
      html =
        normalizeStrikethrough(
          html
        );

      /*
       * CSS untuk Word.
       */
      const escapedTitle =
        safeName
          .replace(
            /&/g,
            '&amp;'
          )
          .replace(
            /</g,
            '&lt;'
          )
          .replace(
            />/g,
            '&gt;'
          )
          .replace(
            /"/g,
            '&quot;'
          );

      const fullHtml =
        `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">

<title>${escapedTitle}</title>

<style>

  @page {
    margin: 0.7in;
  }

  body {
    font-family:
      'Segoe UI',
      Calibri,
      Arial,
      sans-serif;

    font-size:
      11pt;

    color:
      #000000;
  }

  table {
    border-collapse:
      collapse;
  }

  td,
  th {
    vertical-align:
      top;
  }

  img {
    max-width:
      100%;

    height:
      auto;
  }

  ul {
    list-style-type:
      disc;

    list-style-position:
      outside;
  }

  ul ul {
    list-style-type:
      circle;
  }

  ul ul ul {
    list-style-type:
      square;
  }

  ol {
    list-style-type:
      decimal;

    list-style-position:
      outside;
  }

  li {
    list-style-position:
      outside;
  }

  s,
  strike,
  del {
    text-decoration:
      line-through;
  }

  span {
    text-decoration-color:
      inherit;
  }

</style>
</head>

<body>
${html}
</body>
</html>`;

      fs.writeFileSync(
        htmlInputPath,
        fullHtml,
        'utf8'
      );

      /*
       * HTML -> DOCX
       *
       * LibreOffice akan:
       * - embed data URL image
       * - preserve font color
       * - preserve line-through
       * - convert ul/li menjadi Word list
       */
      const convertedDocx =
        await convertWithLibreOffice(
          htmlInputPath,
          docxOutputDir,
          'docx:Office Open XML Text'
        );

      let outputPath =
        convertedDocx;

      /*
       * DOC legacy tetap didukung.
       */
      if (
        format === 'doc'
      ) {

        const convertedDoc =
          await convertWithLibreOffice(
            convertedDocx,
            finalDocPath,
            'doc:MS Word 97'
          );

        outputPath =
          convertedDoc;
      }

      return res.download(
        outputPath,
        `${safeName}.${format}`,
        error => {

          if (error) {

            console.error(
              'Download response error:',
              error.message
            );
          }

          cleanupPaths([
            requestDir
          ]);
        }
      );

    } catch (error) {

      console.error(
        'Download conversion error:',
        error.stderr ||
          error.message
      );

      cleanupPaths([
        requestDir
      ]);

      return res
        .status(500)
        .send(
          `Gagal membuat file ${format.toUpperCase()}.\n\n${
            error.stderr ||
            error.message ||
            'Unknown error'
          }`
        );
    }
  }
);

if (
  require.main === module
) {

  app.listen(
    PORT,
    () => {

      console.log(
        `Server berjalan di http://localhost:${PORT}`
      );

      console.log(
        `LibreOffice: ${getLibreOfficeCommand()}`
      );
    }
  );
}

module.exports = app;