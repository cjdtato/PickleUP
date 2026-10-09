const C='pb-v8-32-3';
const MAXC=120;
const SHELL=['./','icon-192.png','icon.svg','manifest.webmanifest','logo-96.webp','logo-256.webp','favicon-64.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method!=='GET'||u.origin!==location.origin||u.pathname==='/api'||u.pathname.startsWith('/api/'))return;
  const put=(k,res)=>{if(res.ok){const c=res.clone();return caches.open(C).then(x=>x.put(k,c).then(()=>x.keys()).then(ks=>Promise.all(ks.slice(0,Math.max(0,ks.length-MAXC)).map(q=>x.delete(q)))))}}; // keep the cache bounded: oldest entries go first
  if(r.mode!=='navigate'&&/\.(?:webp|png|svg|js|webmanifest)$/.test(u.pathname)){
    // static files: answer from cache instantly, refresh in the background (stale-while-revalidate)
    const upd=fetch(r).then(res=>put(r,res)).catch(()=>{});
    e.waitUntil(upd);
    e.respondWith(caches.match(r).then(m=>m||upd.then(()=>caches.match(r)).then(x=>x||fetch(r))));
    return;
  }
  // pages: network first so a new deploy shows up immediately; cached copy when offline. /?ci=CODE links share one entry.
  const key=r.mode==='navigate'?'./':r;
  e.respondWith(fetch(r).then(res=>{e.waitUntil(Promise.resolve(put(key,res)).catch(()=>{}));return res}).catch(()=>caches.match(key).then(m=>m||caches.match('./'))));
});
