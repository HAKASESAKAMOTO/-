const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs=[]; p.on('pageerror', e=>errs.push(e.message)); p.on('console', m=>{ if(m.type()==='error') errs.push(m.text()); });
  const url = process.argv[2], out = process.argv[3];
  await p.goto(url, { waitUntil: 'networkidle' }).catch(()=>{});
  await p.waitForTimeout(2500);
  await p.screenshot({ path: out, fullPage: process.argv[4]==='full' });
  console.log(JSON.stringify(errs));
  await b.close();
})();
