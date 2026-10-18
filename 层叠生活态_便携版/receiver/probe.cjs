const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('console', m=>console.log('console', m.type(), m.text())); p.on('pageerror', e=>console.log('pageerror', e.message));
  await p.goto(process.argv[2], { waitUntil: 'load' }); await p.waitForTimeout(4000);
  console.log(await p.evaluate(()=>({h:document.documentElement.scrollHeight, len:document.body.innerText.length, html:document.getElementById('root').innerHTML.slice(0,300)})));
  await b.close();
})();
