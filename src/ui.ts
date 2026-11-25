type Row = {id:string; name:string; type?:string; sha256?:string; inspection?:unknown; excerpt?:string};
type Rule = {text:string; state:"Observed"|"Inferred"|"Unknown"; evidence:string[]};
type Spec = {rules:Rule[]};
type Step = {id:string;kind:string;from:string};
type State = {
  id:string; name:string; spec:Spec|null; specRevision:string|null; approved:string|null;
  draft:{source:string;revision:string}|null; code:string|null; steps:Step[]; evidence:Row[];
};
type Answer = {value:unknown;receipt:{id:string;backend:string}};
interface WorkbenchAPI {
  request(op:string,args:Record<string,unknown>):Promise<Answer>;
  chooseFile():Promise<string|null>;
}
const api = (window as Window & {workbench?:WorkbenchAPI}).workbench;
const by = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;
const pretty = (value:unknown) => JSON.stringify(value, null, 2);
const status = by("status");
const result = by("result");
const select = by<HTMLSelectElement>("projects");
const connection = by<HTMLSelectElement>("connection");
const spec = by<HTMLTextAreaElement>("spec");
const code = by<HTMLTextAreaElement>("code");
const recipe = by<HTMLTextAreaElement>("recipe");
const recipeInput = by<HTMLTextAreaElement>("recipeInput");
const review = by<HTMLDialogElement>("review");
let state:State|null = null;
let busy = false;
let connected = false;
const sampleConnection = "demo-fixture";
let sampleImports: string | null = null;
const sampleInput = {artifact:"E2", logs:["WARN first","ERROR last","INFO final","malformed"]};

function options(element:HTMLSelectElement, rows:{id:string;name:string}[], placeholder:string) {
  const current = element.value;
  element.replaceChildren(new Option(placeholder,""), ...rows.map(row => new Option(row.name,row.id)));
  if (rows.some(row => row.id===current)) element.value=current;
}
function controls() {
  document.querySelectorAll<HTMLButtonElement>("button[data-project]").forEach(button => {
    button.disabled = !state || busy || !connected;
  });
  by<HTMLButtonElement>("cancel").disabled = !busy || !connected;
  select.disabled = busy || !connected;
  document.querySelectorAll<HTMLButtonElement>("button[data-action], #newProject button").forEach(button => {
    button.disabled = busy || !connected;
  });
}
async function call<T>(op:string,args:Record<string,unknown>={}) {
  if (!api) throw new Error("Launch through Desk Code");
  return (await api.request(op,args)) as Answer & {value:T};
}
function renderRules(current:State|null) {
  const list=by("reviewRules");
  const panel=by("ruleEvidence");
  list.replaceChildren();
  if (!current?.spec) {
    panel.textContent="Draft or save a specification to review its rules.";
    return;
  }
  panel.textContent="Select a rule to see its evidence.";
  current.spec.rules.forEach((rule,index)=>{
    const item=document.createElement("li");
    const button=document.createElement("button");
    button.type="button";
    button.dataset.project="";
    button.setAttribute("aria-controls",panel.id);
    button.setAttribute("aria-pressed","false");
    const label=document.createElement("strong");
    label.textContent=rule.text;
    const meta=document.createElement("span");
    const refs=[...new Set(rule.evidence)];
    meta.className="rule-meta";
    meta.textContent=rule.state + " · " + (refs.join(", ") || "No evidence linked");
    button.append(label,meta);
    item.append(button);
    list.append(item);
    button.addEventListener("click",()=>void action(async()=>{
      list.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed","false");
      button.setAttribute("aria-pressed","true");
      panel.textContent="Loading evidence…";
      try {
        const {value}=await call<Row[]>("ruleEvidence",{id:current.id,revision:current.specRevision,index});
        panel.replaceChildren();
        if (!value.length) panel.textContent="No evidence is linked to this rule.";
        for (const record of value) {
          const card=document.createElement("article");
          const heading=document.createElement("h5");
          heading.textContent=record.id + " · " + record.name;
          const digest=document.createElement("p");
          digest.className="hash";
          digest.textContent="SHA-256 " + record.sha256;
          const body=document.createElement("pre");
          body.textContent=record.excerpt ?? (record.inspection === undefined
            ? "The source excerpt is unavailable in this project. Only its reference was retained."
            : pretty(record.inspection));
          card.append(heading,digest,body);
          panel.append(card);
        }
      } catch (error) {
        panel.textContent="Could not load this rule’s evidence.";
        throw error;
      }
    }));
  });
}
function render(next:State|null) {
  state=next;
  by("activeProject").textContent=next?.name ?? "Create or open a project";
  spec.value=next?.spec ? pretty(next.spec) : "";
  renderRules(next);
  code.value=next?.draft?.source ?? "";
  recipe.value=next?.steps.length ? pretty(next.steps) : pretty([
    {id:"inspect",kind:"rea",from:"input.artifact"},
    {id:"diagnose",kind:"generated",from:"input.logs"},
    {id:"reference",kind:"mcp",from:"diagnose"},
  ]);
  const evidence=by("evidence");
  evidence.replaceChildren();
  for (const row of next?.evidence ?? []) {
    const line=document.createElement("div");
    const label=document.createElement("strong");
    label.textContent=row.id + "  " + row.name;
    const details=document.createElement("div");
    details.className="hash";
    details.textContent=row.sha256 ?? "";
    line.append(label,details);
    if (row.inspection) {
      const raw=document.createElement("pre");
      raw.textContent=pretty(row.inspection);
      line.append(raw);
    }
    evidence.append(line);
  }
  controls();
}
async function projects(active?:string) {
  const {value}=await call<Row[]>("list");
  options(select,value,"Choose a project");
  if (active) select.value=active;
}
async function action(job:()=>Promise<unknown>) {
  if (busy) return;
  busy=true;
  controls();
  status.textContent="Desk Code operation in progress…";
  try {
    const value=await job();
    if (value !== undefined) result.textContent=pretty(value);
    status.textContent="Desk Code connected";
  } catch(error) {
    status.textContent=String(error instanceof Error ? error.message : error);
  } finally {
    busy=false;
    controls();
  }
}
function click(id:string, job:()=>Promise<unknown>) {
  by(id).addEventListener("click", () => {void action(job);});
}
function project() {
  if (!state) throw new Error("Open a project first");
  return state;
}
async function edit(op:string, args:Record<string,unknown>={}) {
  const {value,receipt}=await call<State>(op,{id:project().id,...args});
  render(value);
  return receipt;
}
async function model(op:string) {
  const {value}=await call<{ticket:string;cloud:boolean;preview:unknown}>(op,{id:project().id,connection:connection.value});
  by("reviewTitle").textContent=value.cloud ? "Review cloud model request" : "Review local model request";
  by("reviewPayload").textContent=pretty(value.preview);
  review.returnValue="cancel";
  review.showModal();
  const consent=await new Promise<boolean>(resolve=>review.addEventListener("close",()=>resolve(review.returnValue==="confirm"),{once:true}));
  if (!consent) return;
  const response=await call<State>("confirmModel",{ticket:value.ticket,consent:true});
  render(response.value);
  return response.receipt;
}
by("newProject").addEventListener("submit", event=>{
  event.preventDefault();
  void action(async()=>{
    const {value,receipt}=await call<State>("create",{name:by<HTMLInputElement>("projectName").value});
    render(value); await projects(value.id); return receipt;
  });
});
click("startSample",async()=>{
  if (!sampleImports) throw new Error("Launch the Workbench demo to open the sample");
  const {value}=await call<State>("create",{name:"Sample: Log diagnostics"});
  render(value);
  await projects(value.id);
  for (const filename of ["behavior.txt","where.exe"]) {
    await edit("import",{path:sampleImports + "/" + filename});
  }
  connection.value=sampleConnection;
  recipeInput.value=pretty(sampleInput);
  return {project:value.name,next:"Draft from evidence in Extraction Mode"};
});
select.addEventListener("change",()=>{
  void action(async()=>{if (select.value) render((await call<State>("get",{id:select.value})).value); else render(null);});
});
click("importFile",async()=>{const path=await api?.chooseFile();if(path)return edit("import",{path});});
click("importBundle",async()=>{
  const path=await api?.chooseFile();
  if(!path)return;
  const {value,receipt}=await call<State>("importBundle",{path});
  render(value); await projects(value.id); return receipt;
});
click("draftSpec",()=>model("prepareDraft"));
click("saveSpec",()=>edit("saveSpec",{spec:JSON.parse(spec.value)}));
click("approveSpec",async()=>{
  const current=project();
  if (pretty(JSON.parse(spec.value))!==pretty(current.spec)) throw new Error("Save spec edits before approval");
  return edit("approveSpec",{revision:current.specRevision});
});
click("draftCode",()=>model("prepareCode"));
click("acceptCode",()=>edit("acceptCode",{revision:project().draft?.revision ?? null}));
click("testCode",()=>call("testCode",{id:project().id}));
click("saveRecipe",()=>edit("saveRecipe",{steps:JSON.parse(recipe.value)}));
click("testStep",()=>call("run",{id:project().id,input:JSON.parse(recipeInput.value),step:by<HTMLInputElement>("stepId").value}));
click("runRecipe",()=>call("run",{id:project().id,input:JSON.parse(recipeInput.value),step:null}));
click("export",()=>call("export",{id:project().id}));
by("vendorForm").addEventListener("submit",event=>{
  event.preventDefault();
  void action(()=>edit("vendor",{component:by<HTMLSelectElement>("vendorName").value}));
});
by("cancel").addEventListener("click",()=>{
  void call("cancel").then(()=>{status.textContent="Cancellation requested";}).catch(()=>{});
});
controls();
void (async()=>{
  try {
    status.textContent="Opening Desk Code connection…";
    const {value}=await call<{components:string[];imports:string}>("hello");
    const rows=(await call<{id:string;model:string;cloud:boolean}[]>("listConnections")).value;
    options(connection,rows.map(row=>({id:row.id,name:row.model+(row.cloud?" (cloud)":" (local)")})),"Choose a model");
    if (rows.some(row=>row.id===sampleConnection && !row.cloud)) {
      sampleImports=value.imports;
      by("sampleGuide").hidden=false;
    }
    options(by<HTMLSelectElement>("vendorName"),(value.components??[]).map(id=>({id,name:id})),"Choose a component");
    await projects();
    connected=true;
    status.textContent="Desk Code connected";
  } catch(error) {
    status.textContent=String(error);
  }
  controls();
})();
