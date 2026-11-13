import {chromium} from '@playwright/test';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const executable=process.env.ERNIE_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser=await chromium.launch({headless:true,...(existsSync(executable)?{executablePath:executable}:{})});
try {
  const page=await browser.newPage({viewport:{width:1200,height:630},deviceScaleFactor:1});
  const svg=await readFile(new URL('../docs/site-assets/social.svg',import.meta.url),'utf8');
  await page.setContent('<style>html,body{margin:0;background:#080c14;overflow:hidden}svg{display:block}</style>'+svg);
  await page.screenshot({path:fileURLToPath(new URL('../docs/site-assets/social.png',import.meta.url)),animations:'disabled'});
  console.log('Generated docs/site-assets/social.png (1200 × 630).');
} finally {await browser.close();}
