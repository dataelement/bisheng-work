import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Native view/IPC regression with local semantic portal fixtures and an isolated profile.
// Run on Windows for platform acceptance; other hosts report their actual platform.
const root = resolve(import.meta.dirname, '..')
const output = resolve(process.argv[2] || 'outputs/enterprise-modal')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-modal-'))
await mkdir(output, { recursive: true })
const html = `<!doctype html><html><head><style>
*{box-sizing:border-box}body{margin:0;background:#fff;color:#222;font:15px sans-serif}
#root{height:100vh;background:#fff;padding:30px}button{padding:8px 20px;margin:8px}
.mask{position:fixed;inset:0;background:transparent;z-index:100}
[role=dialog],[role=alertdialog]{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,90vw);background:white;padding:24px;border-radius:12px;z-index:101;box-shadow:0 5px 18px #0003}
</style></head><body><main id="root"><h2>Tools and skills · local fixture</h2><button id="upload">Upload skill</button><p>The page keeps its original content bounds.</p></main><script>
window.maskClicks=0;window.pageClicks=0;
document.querySelector('#upload').onclick=()=>openModal();
document.querySelector('#root').onclick=()=>window.pageClicks++;
window.openModal=(nested=false)=>{const portal=document.createElement('section');portal.className='portal';
portal.innerHTML='<div class="mask dsh-knowledge-overlay"></div><div role="'+(nested?'alertdialog':'dialog')+'" aria-modal="true" data-state="open"><h3>'+(nested?'Confirm action':'Upload skill')+'</h3><p>Local presentation fixture</p><button class="close">Cancel</button><button class="nested">Confirm</button></div>';
document.body.append(portal);portal.querySelector('.close').onclick=()=>portal.remove();portal.querySelector('.nested').onclick=()=>openModal(true);
portal.querySelector('.mask').onclick=()=>{window.maskClicks++;portal.remove()};portal.querySelector('.close').focus()};
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('.portal:last-child')?.remove()});
</script></body></html>`
try {
  await build({ entryPoints: [join(root, 'src/preload/enterprise-chat.ts')], outfile: join(temporary, 'preload/enterprise-chat.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  await build({ stdin: { contents: `
    import assert from 'node:assert/strict'
    import { createServer } from 'node:http'
    import { writeFile } from 'node:fs/promises'
    import { app, BrowserWindow, webContents } from 'electron'
    import { EnterpriseChatView } from './src/main/enterprise/chat-view'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    const pause = () => new Promise(r => setTimeout(r, 30))
    async function until(check) { for(let i=0;i<150;i++){if(await check())return;await pause()}throw new Error('Presentation timed out') }
    app.whenReady().then(async()=>{
      const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(${JSON.stringify(html)})})
      await new Promise(r=>server.listen(0,'127.0.0.1',r))
      const base='http://127.0.0.1:'+server.address().port
      const window=new BrowserWindow({width:1084,height:998,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
      await window.loadURL('data:text/html,'+encodeURIComponent('<body style="margin:0;background:#f6f7f8;font:15px sans-serif"><aside style="width:280px;padding:40px 20px">Conversation list<button onclick="window.sidebarClicks++">New conversation</button></aside><script>window.sidebarClicks=0</script>'))
      const enterprise={snapshot:()=>({connected:true,connectionKey:'fixture'}),subscribe:()=>()=>{},webSession:async()=>({base,cookieName:'fixture',cookie:'fixture',expiresAt:Date.now()+300000})}
      const host=new EnterpriseChatView(enterprise,line=>{if(line.includes('failed'))console.error(line)})
      const results=[]
      try {
        for(const size of [900,1084])for(const zoom of [0.8,1,1.25])for(const theme of ['light','dark']){
          window.setSize(size,998)
          window.webContents.setZoomFactor(zoom)
          const [width,height]=window.getContentSize()
          const bounds={x:280/zoom,y:40/zoom,width:(width-280)/zoom,height:(height-40)/zoom}
          const presentation={visible:true,theme,bounds}
          host.present(window,presentation)
          await until(()=>host.snapshot().phase==='ready')
          const wc=webContents.getAllWebContents().find(w=>w!==window.webContents&&w.getURL().startsWith(base))
          assert.ok(wc)
          wc.setZoomFactor(zoom)
          await wc.loadURL(base+'/workspace/capabilities')
          await until(()=>host.snapshot().phase==='ready')
          host.present(window,presentation)
          const view=window.contentView.children[0]
          const region={x:280,y:40,width:width-280,height:height-40}
          assert.deepEqual(view.getBounds(),region)
          const before=await wc.executeJavaScript('JSON.stringify(document.querySelector("#root").getBoundingClientRect())')
          await wc.executeJavaScript('openModal()')
          await until(()=>view.getBounds().x===0)
          await until(()=>wc.executeJavaScript('document.documentElement.dataset.dshWindowDialog==="open"'))
          assert.deepEqual(view.getBounds(),{x:0,y:0,width,height})
          const geometry=await wc.executeJavaScript('(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {root:rect("#root"),mask:rect(".mask"),dialog:rect("[role=dialog]"),hit:document.elementFromPoint(30,100).className}})()')
          const close=(a,b)=>assert.ok(Math.abs(a-b)<1, a+' != '+b)
          close(geometry.root.x*zoom,280);close(geometry.root.y*zoom,40)
          close(geometry.root.width,JSON.parse(before).width);close(geometry.root.height,JSON.parse(before).height)
          close(geometry.mask.width*zoom,width);close(geometry.mask.height*zoom,height)
          close((geometry.dialog.x+geometry.dialog.width/2)*zoom,width/2)
          assert.equal(geometry.hit,'mask dsh-knowledge-overlay')
          assert.equal(await wc.executeJavaScript('getComputedStyle(document.querySelector(".mask")).backgroundColor'), 'rgba(0, 0, 0, 0)')
          await wc.executeJavaScript('openModal(true)')
          await wc.executeJavaScript('document.querySelector(".portal:last-child").remove()')
          await pause();assert.equal(view.getBounds().x,0)
          if(size===1084&&zoom===1&&theme==='light')await writeFile(${JSON.stringify(join(output, 'window-modal.png'))},(await wc.capturePage()).toPNG())
          wc.sendInputEvent({type:'mouseDown',x:30,y:100,button:'left',clickCount:1})
          wc.sendInputEvent({type:'mouseUp',x:30,y:100,button:'left',clickCount:1})
          await until(()=>view.getBounds().x===280)
          assert.equal(await wc.executeJavaScript('window.maskClicks'),1)
          assert.equal(await window.webContents.executeJavaScript('window.sidebarClicks'),0)
          await wc.executeJavaScript('openModal()');await until(()=>view.getBounds().x===0)
          wc.sendInputEvent({type:'keyDown',keyCode:'Escape'});wc.sendInputEvent({type:'keyUp',keyCode:'Escape'})
          await until(()=>view.getBounds().x===280)
          assert.deepEqual(view.getBounds(),region)
          results.push({size,zoom,theme,geometry});console.log('PASS native portal width='+size+' zoom='+zoom+' theme='+theme)
        }
        await writeFile(${JSON.stringify(join(output, 'native-results.json'))},JSON.stringify({platform:process.platform,electron:process.versions.electron,fixture:'local semantic body portals',results},null,2))
      }finally{host.dispose();window.destroy();server.close()}
      app.exit(0)
    }).catch(error=>{console.error(error);app.exit(1)})
  `, resolveDir: root, loader: 'ts' }, outfile: join(temporary, 'main/index.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], define: { 'import.meta.dirname': '__dirname' } })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [join(temporary, 'main/index.cjs')], { env, stdio: 'inherit', signal: AbortSignal.timeout(60_000) })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, 'Native modal verification failed')
} finally { await rm(temporary, { recursive: true, force: true }) }
