import { app, BrowserWindow, ipcMain, dialog, protocol } from "electron";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const view = "workbench://app/index.html";
const resources = new Map([
  ["/index.html", join(root, "ui", "index.html")],
  ["/style.css", join(root, "ui", "style.css")],
  ["/dist/ui.js", join(root, "dist", "ui.js")],
]);
protocol.registerSchemesAsPrivileged([{ scheme: "workbench", privileges: { standard: true, secure: true,
  supportFetchAPI: true, corsEnabled: true } }]);
const operations = new Set([
  "hello", "list", "create", "get", "import", "listConnections", "prepareDraft",
  "saveSpec", "approveSpec", "ruleEvidence", "prepareCode", "confirmModel", "acceptCode", "saveRecipe",
  "vendor", "run", "export", "importBundle", "testCode", "cancel",
]);
const port = process.env.WORKBENCH_DESK_PORT ?? "";
const token = process.env.WORKBENCH_DESK_SESSION ?? "";
let window: BrowserWindow | undefined;

if (!/^\d{1,5}$/.test(port) || Number(port) > 65535 || !/^[\w-]{43}$/.test(token)) {
  process.stderr.write("REA Workbench must be launched by Desk Code.\n");
  app.exit(1);
} else {
  function trusted(sender: {url: string} | null) {
    if (sender?.url !== view) throw new Error("Untrusted Workbench window");
  }

  ipcMain.handle("workbench:request", async (event, operation: string, args: unknown) => {
    trusted(event.senderFrame);
    if (!operations.has(operation) || !args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Invalid Workbench request");
    }
    const message = JSON.stringify({ op: operation, args });
    if (Buffer.byteLength(message) > 2 * 1024 * 1024) throw new Error("Request is too large");
    let response: Response;
    try {
      response = await fetch("http://127.0.0.1:" + port + "/workbench/v1", {
        method:"POST", headers:{"Content-Type":"application/json","Authorization":"Bearer " + token},
        body:message, redirect:"error", signal:AbortSignal.timeout(110_000),
      });
    } catch {
      throw new Error("Desk Code disconnected. Check the operation before retrying.");
    }
    const result = await response.json();
    if (!result.ok) throw new Error(result.error + (result.receipt ? " [" + result.receipt.id + "]" : ""));
    return {value:result.value, receipt:result.receipt};
  });

  ipcMain.handle("workbench:file", async (event) => {
    trusted(event.senderFrame);
    if (!window) return null;
    const picked = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [{name:"Evidence and Workbench bundles",extensions:["txt","log","json","md","csv","exe","dll","zip","asar"]}],
    });
    return picked.canceled ? null : picked.filePaths[0];
  });

  app.whenReady().then(async () => {
    const smoke = process.argv.includes("--pilot-ui-smoke");
    protocol.handle("workbench", async (request) => {
      const parsed = new URL(request.url);
      const resource = parsed.hostname === "app" && resources.get(parsed.pathname);
      if (!resource) return new Response(null, {status: 404});
      const mime = parsed.pathname.endsWith(".html") ? "text/html" :
        parsed.pathname.endsWith(".css") ? "text/css" : "text/javascript";
      return new Response(new Uint8Array(await readFile(resource)).buffer, {
        headers: {"Content-Type": mime + "; charset=utf-8"},
      });
    });
    window = new BrowserWindow({
      width: 1280, height: 840, minWidth: 860, minHeight: 610, show: !smoke,
      title: "REA Workbench", autoHideMenuBar: true,
      webPreferences: { preload: join(root, "src", "preload.cjs"),
        nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    if (smoke) {
      window.webContents.on("console-message", event => process.stderr.write("[electron] " + event.message + "\n"));
      window.webContents.on("preload-error", (_event, _path, error) =>
        process.stderr.write("[preload] " + error.message + "\n"));
    }
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    await window.loadURL(view);
    if (smoke) {
      const status = await window.webContents.executeJavaScript(
        "new Promise(resolve => {const timer=setInterval(()=>{const s=document.querySelector('#status')?.textContent;if(s?.includes('Desk Code connected')){clearInterval(timer);resolve(s);}},30);setTimeout(()=>{clearInterval(timer);resolve(document.querySelector('#status')?.textContent);},5000);})");
      if (typeof status === "string" && status.includes("Desk Code connected")) {
        const created = await window.webContents.executeJavaScript(
          "new Promise(resolve=>{document.querySelector('#projectName').value='Pilot smoke project';document.querySelector('#newProject').requestSubmit();const t=setInterval(()=>{if(document.querySelector('#activeProject')?.textContent==='Pilot smoke project'&&!document.querySelector('#newProject button').disabled){clearInterval(t);resolve(true);}},35);setTimeout(()=>{clearInterval(t);resolve(false);},5000);})");
        if (!created) process.stderr.write("Workbench UI did not create a project through Desk Code\n");
        const sample = await window.webContents.executeJavaScript(
          "document.querySelector('#sampleGuide').hidden ? null : new Promise(resolve => {" +
          "document.querySelector('#startSample').click();" +
          "const timer=setInterval(()=>{if(document.querySelector('#startSample').disabled)return;" +
          "clearInterval(timer);clearTimeout(timeout);resolve(" +
          "document.querySelector('#activeProject').textContent==='Sample: Log diagnostics' && " +
          "document.querySelectorAll('#evidence > div').length===2 && " +
          "document.querySelector('#evidence').textContent.includes('behavior.txt') && " +
          "document.querySelector('#evidence').textContent.includes('where.exe') && " +
          "document.querySelector('#connection').value==='demo-fixture' && " +
          "JSON.parse(document.querySelector('#recipeInput').value||'{}').artifact==='E2');},35);" +
          "const timeout=setTimeout(()=>{clearInterval(timer);resolve(false);},12000);})");
        if (sample === false) {
          const status = await window.webContents.executeJavaScript(
            "document.querySelector('#status').textContent");
          process.stderr.write("Workbench UI did not prepare the sample project: " + String(status) + "\n");
        }
        if (sample === true) {
          process.stdout.write("Workbench guided sample prepared\n");
          const verified = await window.webContents.executeJavaScript(
            "(" + (async () => {
              async function until(ready:()=>boolean) {
                const end=Date.now()+5000;
                while (!ready()) {
                  if (Date.now()>=end) throw new Error("Evidence review did not respond");
                  await new Promise(resolve=>setTimeout(resolve,35));
                }
              }
              document.querySelector<HTMLButtonElement>("#draftSpec")!.click();
              await until(()=>document.querySelector<HTMLDialogElement>("#review")!.open);
              document.querySelector<HTMLButtonElement>("#review button[value=confirm]")!.click();
              const buttons=()=>Array.from(document.querySelectorAll<HTMLButtonElement>("#reviewRules button"));
              await until(()=>buttons().length===3 && !buttons()[0]!.disabled);
              buttons()[0]!.click();
              const evidence=()=>document.querySelector("#ruleEvidence")!.textContent ?? "";
              await until(()=>!buttons()[0]!.disabled);
              if (!evidence().includes("E1 · behavior.txt") || !evidence().includes("nonempty message") ||
                  !evidence().includes("SHA-256") || buttons()[0]!.getAttribute("aria-pressed")!=="true") return false;
              buttons()[2]!.click();
              await until(()=>!buttons()[2]!.disabled);
              return evidence()==="No evidence is linked to this rule." &&
                buttons()[0]!.getAttribute("aria-pressed")==="false";
            }).toString() + ")()");
          if (!verified) {
            process.stderr.write("Workbench did not display the selected rule’s evidence\n");
            app.exit(1);
            return;
          }
          process.stdout.write("Workbench evidence review verified\n");
        }
        app.exit(created && sample !== false ? 0 : 1);
      } else {
        const diagnostics = await window.webContents.executeJavaScript(
          "JSON.stringify({api:!!window.workbench,url:location.href,resources:performance.getEntriesByType('resource').map(x=>x.name)})");
        process.stderr.write("Workbench UI connection failed " + String(status) + " " + diagnostics + "\n");
        app.exit(1);
      }
    }
  }).catch((error) => {
    process.stderr.write(String(error) + "\n");
    app.exit(1);
  });
  app.on("window-all-closed", () => app.quit());
}
