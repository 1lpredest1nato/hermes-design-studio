import {useEffect,useRef,useState} from 'react';
import {Button,Input,Textarea,KEYBINDS_AREA,host,useQuery} from '@hermes/plugin-sdk';
import {paramValue,paramDefaults,createCommandChannel,importImage} from './controls.jsx';
import {uploadChunks} from './upload.mjs';

const TYPES=['float','int','bool','color','enum'];
const initialDraft={name:'My tool',description:'',shader:'void main() {\n  outColor = texture(u_input, v_uv);\n}',params:[]};
const CSS=`
.hds{height:100%;min-height:420px;display:flex;flex-direction:column;overflow:hidden;color:var(--ui-text-primary);font-size:12px;background:var(--ui-bg-editor)}
.hds *{box-sizing:border-box}.hds h1,.hds h2,.hds h3,.hds p{margin:0}.hds h1{font-size:14px;font-weight:600;letter-spacing:-.025em}.hds h2{font-size:12px;font-weight:600}.hds h3{font-size:12px;font-weight:500}.hds button,.hds input,.hds select,.hds textarea{font:inherit}.hds button{cursor:pointer}.hds button:disabled{cursor:default;opacity:.45}.hds :focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}.hds input[type=range],.hds input[type=checkbox]{accent-color:var(--ui-accent)}
.hds .ds-top{display:flex;align-items:center;gap:16px;min-height:60px;padding:12px 18px;border-bottom:1px solid var(--ui-stroke-secondary);flex-wrap:wrap}.hds .ds-brand{margin-right:auto;display:grid;gap:4px}.hds .ds-eyebrow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ui-text-tertiary)}.hds .ds-muted{color:var(--ui-text-tertiary);line-height:1.55}.hds .ds-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hds .ds-space{justify-content:space-between}.hds .ds-columns{display:grid;grid-template-columns:232px minmax(240px,1fr) 320px;flex:1;min-height:0;overflow:auto}.hds .ds-panel{min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:16px}.hds .ds-left{border-right:1px solid var(--ui-stroke-secondary)}.hds .ds-right{border-left:1px solid var(--ui-stroke-secondary)}.hds .ds-heading{display:flex;justify-content:space-between;align-items:center;gap:8px}.hds .ds-count{font-variant-numeric:tabular-nums;color:var(--ui-text-tertiary)}
.hds .ds-empty{padding:24px 10px;display:grid;gap:8px;text-align:center;line-height:1.6;color:var(--ui-text-tertiary);border:1px dashed var(--ui-stroke-secondary);border-radius:6px}.hds .ds-stack{display:grid;gap:6px}.hds .ds-node{padding:10px;border:1px solid var(--ui-stroke-secondary);border-radius:5px;display:grid;gap:8px;background:var(--ui-bg-editor)}.hds .ds-node[data-selected=true]{border-color:var(--ui-accent);background:var(--ui-bg-card)}.hds .ds-node-title{border:0;padding:0;background:none;color:var(--ui-text-primary);text-align:left;flex:1;min-width:0}.hds .ds-node-title span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hds .ds-number{font-size:10px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}.hds .ds-select{border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-input);color:var(--ui-text-primary);padding:5px 7px;border-radius:4px;min-width:0;max-width:100%}.hds .ds-field{display:grid;gap:7px;min-width:0}.hds .ds-field-head{display:flex;justify-content:space-between;gap:8px}.hds .ds-value{color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}.hds .ds-divider{height:1px;background:var(--ui-stroke-secondary);flex-shrink:0}.hds .ds-fields{display:grid;gap:18px}.hds .ds-canvas-column{display:flex;flex-direction:column;min-width:0;min-height:360px}.hds .ds-canvas-toolbar{padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid var(--ui-stroke-secondary);flex-wrap:wrap}.hds .ds-viewport{flex:1;min-height:260px;position:relative;overflow:auto;background:var(--ui-bg-secondary);display:grid;place-items:center;padding:24px}.hds .ds-viewport[data-drag=true]{outline:2px dashed var(--ui-accent);outline-offset:-8px}.hds .ds-canvas-wrap{width:100%;height:100%;min-height:200px;position:relative;display:grid;place-items:center}.hds canvas{display:block}.hds .ds-canvas-empty{position:absolute;inset:0;display:grid;place-content:center;text-align:center;gap:10px;pointer-events:none;color:var(--ui-text-tertiary)}.hds .ds-canvas-foot{padding:10px 14px;border-top:1px solid var(--ui-stroke-secondary);display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--ui-text-tertiary)}.hds .ds-alert{padding:10px 16px;border-bottom:1px solid var(--ui-stroke-secondary);color:var(--ui-text-primary);background:var(--ui-bg-card);white-space:pre-wrap;line-height:1.6}.hds .ds-alert button{float:right}.hds .ds-card{padding:12px;border:1px solid var(--ui-stroke-secondary);border-radius:5px;display:grid;gap:8px}.hds .ds-tabs{display:flex;gap:4px;border-bottom:1px solid var(--ui-stroke-secondary);padding-bottom:8px}.hds .ds-tabs button[aria-selected=true]{color:var(--ui-accent);background:var(--ui-bg-card)}.hds .ds-bottom{margin-top:auto;padding-top:16px;border-top:1px solid var(--ui-stroke-secondary)}.hds .ds-mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;line-height:1.6}.hds .ds-code{display:flex;min-height:200px}.hds .ds-lines{padding:8px 8px 8px 0;text-align:right;color:var(--ui-text-quaternary);user-select:none;white-space:pre;line-height:1.6;font:11px/1.6 ui-monospace,monospace}.hds .ds-code textarea{width:100%;min-height:200px;white-space:pre;tab-size:2;resize:vertical;font:11px/1.6 ui-monospace,monospace}.hds .ds-table-wrap{overflow:auto}.hds table{width:100%;border-collapse:collapse;text-align:left;font-size:11px}.hds th,.hds td{padding:6px 4px;border-bottom:1px solid var(--ui-stroke-secondary);vertical-align:top}.hds th{font-weight:500;color:var(--ui-text-tertiary)}.hds td input{min-width:65px;width:100%}.hds .ds-mini-preview{height:150px;overflow:hidden;position:relative}.hds .ds-upload{display:grid;gap:6px}.hds progress{width:100%;accent-color:var(--ui-accent)}
.hds[data-theme=minimal]{--hds-bg:#f5f5f2;--hds-fg:#20211f;--hds-muted:#73756f;--hds-line:#d9dbd4;--hds-accent:#3e594b;--ui-bg-editor:var(--hds-bg);--ui-bg-secondary:#eaece6;--ui-bg-input:#fafbf8;--ui-bg-card:#ebeee7;--ui-bg-quaternary:#e5e8e0;--ui-text-primary:var(--hds-fg);--ui-text-secondary:#50554b;--ui-text-tertiary:var(--hds-muted);--ui-text-quaternary:#95998f;--ui-stroke-secondary:var(--hds-line);--ui-accent:var(--hds-accent)}
@media(max-width:1050px){.hds .ds-columns{grid-template-columns:195px minmax(220px,1fr) 285px}.hds .ds-panel{padding:12px}.hds .ds-top{gap:10px}}@media(max-width:760px){.hds .ds-columns{grid-template-columns:180px minmax(300px,1fr) 280px}.hds .ds-top{padding:10px}.hds .ds-viewport{padding:12px}}
`;

function Action({children,...props}) {return <Button type="button" variant="ghost" size="sm" {...props}>{children}</Button>;}
function Message({children}) {return <div className="ds-empty">{children}</div>;}
function NativeSelect({label,value,onChange,children,...props}) {return <select aria-label={label} className="ds-select" value={value} onChange={e=>onChange(e.target.value)} {...props}>{children}</select>;}
function Parameter({param,value,onChange,onGesture}) {
 const gesture=useRef(null);
 const current=value??param.default;
 function change(raw){try {onChange(paramValue(param,raw),gesture.current);}catch{}}
 const begin=()=>{gesture.current=crypto.randomUUID();onGesture?.(gesture.current);};
 const end=()=>{gesture.current=null;};
 return <label className="ds-field"><span className="ds-field-head"><span>{param.label||param.name}</span><span className="ds-value">{String(current??'')}</span></span>
  {param.type==='bool'?<input type="checkbox" checked={Boolean(current)} onChange={e=>change(e.target.checked)}/>:
   param.type==='enum'?<NativeSelect label={param.label||param.name} value={current} onChange={change}>{(param.options||param.values||[]).map(v=><option key={v} value={v}>{v}</option>)}</NativeSelect>:
   param.type==='color'?<div className="ds-row"><input type="color" aria-label={param.label||param.name} value={current||'#ffffff'} onChange={e=>change(e.target.value)}/><span className="ds-mono">{current}</span></div>:
   <div className="ds-row"><input style={{flex:1,minWidth:60}} aria-label={param.label||param.name} type="range" min={param.min??0} max={param.max??1} step={param.type==='int'?1:(param.step??0.01)} value={current??0} onPointerDown={begin} onPointerUp={end} onPointerCancel={end} onKeyDown={e=>{if(!e.repeat)begin();}} onKeyUp={end} onBlur={end} onChange={e=>change(e.target.value)}/><Input aria-label={`${param.label||param.name} exact value`} type="number" style={{width:76}} min={param.min} max={param.max} step={param.type==='int'?1:(param.step??0.01)} value={current??0} onChange={e=>change(e.target.value)}/></div>}
 </label>;
}
function Parameters({params=[],values={},onChange}) {return <div className="ds-fields">{params.map(p=><Parameter key={p.name} param={p} value={values[p.name]} onChange={(value,gesture)=>onChange(p.name,value,gesture)}/>)}</div>;}

function PreviewCanvas({frame,zoom='fit',label='Project preview'}) {
 const container=useRef(null),canvas=useRef(null),bitmap=useRef(null),size=useRef({width:1,height:1});
 const [error,setError]=useState('');
 useEffect(()=>{
  let live=true;
  function draw(){const node=canvas.current,image=bitmap.current;if(!node||!image)return;const {width,height}=size.current;const fit=zoom==='fit'?Math.min(width/image.width,height/image.height,1):1;const w=Math.max(1,Math.round(image.width*fit)),h=Math.max(1,Math.round(image.height*fit));const dpr=globalThis.devicePixelRatio||1;node.width=Math.round(w*dpr);node.height=Math.round(h*dpr);node.style.width=`${w}px`;node.style.height=`${h}px`;const context=node.getContext('2d');if(!context){setError('Canvas 2D is unavailable');return;}context.drawImage(image,0,0,node.width,node.height);}
  const observer=new ResizeObserver(entries=>{const r=entries[0]?.contentRect;if(r){size.current={width:Math.max(1,r.width),height:Math.max(1,r.height)};draw();}});observer.observe(container.current);
  if(frame?.blob)createImageBitmap(frame.blob).then(image=>{if(!live){image.close();return;}bitmap.current=image;setError('');draw();}).catch(e=>live&&setError(String(e)));
  return()=>{live=false;observer.disconnect();bitmap.current?.close();bitmap.current=null;};
 },[frame,zoom]);
 return <div className="ds-canvas-wrap" ref={container}><canvas ref={canvas} aria-label={label}/>{!frame&&<div className="ds-canvas-empty"><span>{label}</span><small>Waiting for the renderer</small></div>}{error&&<div role="alert">{error}</div>}</div>;
}

function RecipesPanel({catalog,service,doc,onRefresh,onApply,onParam}) {
 const [name,setName]=useState('My recipe'),[excluded,setExcluded]=useState([]),[exposed,setExposed]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[active,setActive]=useState(null);
 const live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const stack=(doc?.stack||[]).filter(n=>!excluded.includes(n.uid));
 async function save(){setBusy(true);setError('');try{
  const body={name,stack,exposed:exposed.filter(e=>stack.some(n=>n.uid===e.node_uid))};
  const recipe=await service.rest('/recipes',{method:'POST',body});if(!live.current)return;
  const state=await onRefresh();if(!live.current)return;
  if(!state.catalog?.recipes.some(r=>r.id===recipe.id))throw new Error('Saved recipe not found in the refreshed catalog. Refresh and review.');
  setNotice(`Saved ${recipe.name} on the gateway.`);
 }catch(e){if(live.current)setError(String(e.message||e));}finally{if(live.current)setBusy(false);}}
 async function apply(recipe){setBusy(true);setError('');try{
  const result=await onApply(recipe.id);if(!live.current||!result)return;
  // Associate returned backend UIDs with the frozen recipe order for display only.
  const appended=result.document.stack.slice(-recipe.stack.length);
  setActive({recipe,project:result.document.id,bindings:Object.fromEntries(recipe.stack.map((n,i)=>[n.uid,appended[i]?.uid]))});
  setNotice(`Applied ${recipe.name}. Exposed controls edit its newly added operations.`);
 }catch(e){if(live.current)setError(String(e.message||e));}finally{if(live.current)setBusy(false);}}
 return <section className="ds-fields"><h3>Reusable stacks</h3><p className="ds-muted">Save an ordered subchain with frozen tool versions. Applying appends its operations; it never replaces the source image.</p>
  <details open={!catalog.recipes.length}><summary>Save current stack</summary><div className="ds-fields" style={{paddingTop:12}}><label className="ds-field">Recipe name<Input aria-label="Recipe name" value={name} onChange={e=>setName(e.target.value)}/></label>{doc?.stack.length?doc.stack.map((n,i)=>{const tool=catalog.tools.find(t=>t.ref===n.tool);return <div key={n.uid} className="ds-card"><label className="ds-row"><input type="checkbox" aria-label={`Include operation ${i+1} in recipe`} checked={!excluded.includes(n.uid)} onChange={e=>setExcluded(prev=>e.target.checked?prev.filter(uid=>uid!==n.uid):[...prev,n.uid])}/>{i+1}. {tool?.manifest.name||n.tool}</label>{!excluded.includes(n.uid)&&(tool?.manifest.params||[]).map(p=>{const descriptor=exposed.find(e=>e.node_uid===n.uid&&e.param===p.name);return <div key={p.name} className="ds-field"><label className="ds-row"><input aria-label={`Expose ${p.name} from operation ${i+1}`} type="checkbox" checked={Boolean(descriptor)} onChange={e=>setExposed(prev=>e.target.checked?[...prev,{name:`control${prev.length+1}`,node_uid:n.uid,param:p.name}]:prev.filter(d=>d!==descriptor))}/>{p.label||p.name}</label>{descriptor&&<Input aria-label={`Exposed name for ${p.name} from operation ${i+1}`} value={descriptor.name} onChange={e=>setExposed(prev=>prev.map(d=>d===descriptor?{...d,name:e.target.value}:d))}/>}</div>;})}</div>;}):<Message>Add operations before saving a recipe.</Message>}<p className="ds-muted">Check the parameters you want to expose. Exposed names must be unique identifiers (letters, digits, underscore).</p><Button disabled={!stack.length||!name.trim()||busy} onClick={save}>Save recipe</Button></div></details>
  {error&&<div role="alert" className="ds-mono">{error}</div>}{notice&&<p role="status" className="ds-muted">{notice}</p>}
  {catalog.recipes.length?catalog.recipes.map(recipe=><div className="ds-card" key={recipe.id}><div className="ds-heading"><h3>{recipe.name}</h3><Action aria-label={`Apply ${recipe.name}`} disabled={!doc||busy} onClick={()=>apply(recipe)}>Apply</Action></div><p className="ds-muted">{recipe.stack.length} operations · {(recipe.exposed||[]).length} exposed controls</p><span className="ds-number">{recipe.id}</span></div>):<Message>No saved recipes yet. Save your first stack above.</Message>}
  {active&&active.project===doc?.id&&(active.recipe.exposed||[]).length>0&&<section className="ds-fields"><h3>{active.recipe.name} · exposed controls</h3>{active.recipe.exposed.map(descriptor=>{const uid=active.bindings[descriptor.node_uid],node=doc.stack.find(n=>n.uid===uid),tool=catalog.tools.find(t=>t.ref===node?.tool),param=tool?.manifest.params.find(p=>p.name===descriptor.param);return node&&param?<Parameter key={descriptor.name} param={{...param,label:descriptor.name}} value={node.params[descriptor.param]} onChange={(value,gesture)=>onParam(uid,descriptor.param,value,gesture)}/>:<p className="ds-muted" key={descriptor.name}>{descriptor.name}: operation was removed.</p>;})}</section>}
 </section>;
}

function ParameterTable({params,onChange}) {
 function update(index,patch){onChange(params.map((p,i)=>i===index?{...p,...patch}:p));}
 function changeType(index,type){const defaults={float:{default:0,min:0,max:1},int:{default:0,min:0,max:10},bool:{default:false},color:{default:'#ffffff'},enum:{default:'soft',options:['soft','hard']}};const old=params[index];onChange(params.map((p,i)=>i===index?{name:old.name,label:old.label||old.name,type,...defaults[type]}:p));}
 return <section className="ds-fields"><div className="ds-heading"><h3>Parameter manifest</h3><Action onClick={()=>onChange([...params,{name:`amount${params.length+1}`,type:'float',min:0,max:1,default:0.5}])}>Add parameter</Action></div><div className="ds-table-wrap"><table><thead><tr><th>Name / label</th><th>Type</th><th>Range / options</th><th>Default</th><th/></tr></thead><tbody>{params.map((p,i)=><tr key={i}><td><Input aria-label={`Parameter ${i+1} name`} value={p.name} onChange={e=>update(i,{name:e.target.value})}/><Input aria-label={`Parameter ${i+1} label`} placeholder="Display label" value={p.label||''} onChange={e=>update(i,{label:e.target.value})}/></td><td><NativeSelect label={`Parameter ${i+1} type`} value={p.type} onChange={type=>changeType(i,type)}>{TYPES.map(t=><option key={t}>{t}</option>)}</NativeSelect></td><td>{p.type==='float'||p.type==='int'?<><Input aria-label={`Parameter ${i+1} minimum`} type="number" value={p.min} step={p.type==='int'?1:'any'} onChange={e=>update(i,{min:e.target.value===''?'':Number(e.target.value)})}/><Input aria-label={`Parameter ${i+1} maximum`} type="number" value={p.max} step={p.type==='int'?1:'any'} onChange={e=>update(i,{max:e.target.value===''?'':Number(e.target.value)})}/></>:p.type==='enum'?<Input aria-label={`Parameter ${i+1} options`} placeholder="soft, hard" value={(p.options||[]).join(', ')} onChange={e=>update(i,{options:e.target.value.split(',').map(v=>v.trim())})}/>:<span className="ds-muted">—</span>}</td><td>{p.type==='bool'?<input aria-label={`Parameter ${i+1} default`} type="checkbox" checked={p.default===true} onChange={e=>update(i,{default:e.target.checked})}/>:p.type==='enum'?<NativeSelect label={`Parameter ${i+1} default`} value={p.default} onChange={value=>update(i,{default:value})}>{(p.options||[]).map((o,index)=><option key={index}>{o}</option>)}</NativeSelect>:<Input aria-label={`Parameter ${i+1} default`} type={p.type==='color'?'color':'number'} value={p.default} step={p.type==='int'?1:'any'} onChange={e=>update(i,{default:p.type==='color'?e.target.value:e.target.value===''?'':Number(e.target.value)})}/>}</td><td><Action aria-label={`Remove parameter ${i+1}`} onClick={()=>onChange(params.filter((_,index)=>i!==index))}>×</Action></td></tr>)}</tbody></table></div>{!params.length&&<p className="ds-muted">No custom uniforms yet. Add float, int, bool, color or enum controls.</p>}</section>;
}
function DraftEditor({entry,service,doc,onRefresh,onClose}) {
 const [model,setModel]=useState(()=>entry?{name:entry.manifest.name,description:entry.manifest.description||'',params:entry.manifest.params,shader:entry.shader}:{...initialDraft,params:[]});
 const [saved,setSaved]=useState(entry||null),[values,setValues]=useState(()=>paramDefaults(entry?.manifest.params)),[status,setStatus]=useState('Waiting for edits'),[error,setError]=useState(''),[check,setCheck]=useState(null),[frames,setFrames]=useState(null),[confirmDelete,setConfirmDelete]=useState(false),[action,setAction]=useState('');
 const live=useRef(true),generation=useRef(0);
 const modelKey=JSON.stringify(model),valuesKey=JSON.stringify(values);
 // Keep the exact source snapshot: merely reviewing an agent draft must not
 // resave it as human-authored or reset its backend check receipts.
 const sourceSnapshot=useRef(entry?{key:modelKey,entry}:null);
 useEffect(()=>{live.current=true;return()=>{live.current=false;generation.current++;};},[]);
 function edit(patch){generation.current++;setCheck(null);setFrames(null);setModel(previous=>({...previous,...patch}));setStatus('Edits pending — compile in 600 ms');}
 useEffect(()=>{
  const token=++generation.current;let cancelled=false;setCheck(null);setStatus('Compile scheduled…');
  const active=()=>!cancelled&&live.current&&token===generation.current&&!service.signal.aborted;
  const timer=setTimeout(async()=>{
   if(!active())return;setStatus('Saving and compiling…');setError('');
   try {
    let draft=sourceSnapshot.current?.key===modelKey?sourceSnapshot.current.entry:null;
    if(!draft){
     draft=await service.rest('/drafts',{method:'POST',body:JSON.parse(modelKey)});if(!active())return;
     sourceSnapshot.current={key:modelKey,entry:draft};
    }
    setSaved(draft);
    const params={...paramDefaults(model.params),...JSON.parse(valuesKey)};
    const currentResult=await service.checkDraft(draft,{fixture:false,params});if(!active())return;
    const testResult=await service.checkDraft(draft,{fixture:true,params});if(!active())return;
    for(const result of [currentResult,testResult]) {
     if(result?.ok===false||result?.error||result?.check?.error)throw new Error(result.error||result.check?.error||'Shader check failed');
     const validated=result?.request?.entry;
     if(!validated||!draft.expected_shader_sha||!draft.expected_manifest_sha||
        validated.manifest.id!==draft.manifest.id||validated.expected_shader_sha!==draft.expected_shader_sha||
        validated.expected_manifest_sha!==draft.expected_manifest_sha||result.entry?.expected_shader_sha!==validated.expected_shader_sha||
        result.entry?.expected_manifest_sha!==validated.expected_manifest_sha||
        result.request.shader_sha!==validated.expected_shader_sha||result.check?.shader_sha!==validated.expected_shader_sha||
        !result.request.request_id||result.check?.request_id!==result.request.request_id)
      throw new Error('Draft snapshot/check identity changed. Refresh and compile again.');
    }
    const current=currentResult.frame||currentResult,test=testResult.frame||testResult;
    if(!current?.blob||!test?.blob)throw new Error('Renderer returned no preview. Approval is unavailable until both checks complete.');
    setFrames({current,test});setCheck({id:testResult.entry.manifest.id,expected_shader_sha:testResult.entry.expected_shader_sha,expected_manifest_sha:testResult.entry.expected_manifest_sha,request_ids:[currentResult.request.request_id,testResult.request.request_id],token});setStatus('Compiled · current image + studio test image');
    await onRefresh();
   }catch(e){if(active()){setError(String(e.message||e));setStatus('Check failed · edit the source and retry');setCheck(null);}}
  },600);
  return()=>{cancelled=true;clearTimeout(timer);};
 },[modelKey,valuesKey,doc?.id,doc?.revision,service]);
 async function approve(){if(!saved||!check||check.token!==generation.current)return;setAction('approve');try{
  await service.rest('/drafts/approve',{method:'POST',body:{id:check.id,expected_shader_sha:check.expected_shader_sha,expected_manifest_sha:check.expected_manifest_sha}});if(!live.current)return;
  const state=await onRefresh();if(!live.current)return;
  if(!state.catalog?.tools.some(t=>t.manifest.id===saved.manifest.id))throw new Error('Approval response received, but tool is not in the refreshed catalog. Refresh and review.');
  onClose();
 }catch(e){if(live.current){setError(String(e.message||e));setCheck(null);setStatus('Approval failed · refresh and compile again');}}finally{if(live.current)setAction('');}}
 async function remove(){if(!saved)return;setAction('delete');try{await service.rest(`/drafts?id=${encodeURIComponent(saved.manifest.id)}`,{method:'DELETE'});if(!live.current)return;const state=await onRefresh();if(!live.current)return;if(state.catalog?.drafts.some(t=>t.manifest.id===saved.manifest.id))throw new Error('Draft still exists after deletion. Refresh and try again.');onClose();}catch(e){if(live.current)setError(String(e.message||e));}finally{if(live.current)setAction('');}}
 return <section className="ds-fields" aria-label="Manual shader editor"><div className="ds-heading"><h2>Shader workshop</h2><Action onClick={onClose}>← Drafts</Action></div><p className="ds-muted">Write a GLSL ES 3.00 fragment tool. No agent is required. Changes save and compile after a short pause.</p><label className="ds-field">Tool name<Input aria-label="Tool name" value={model.name} onChange={e=>edit({name:e.target.value})}/></label><label className="ds-field">Description<Input aria-label="Tool description" value={model.description} onChange={e=>edit({description:e.target.value})}/></label>
  <details><summary>Shader contract & safety</summary><p className="ds-muted ds-mono">u_input · u_resolution · u_time (0) · u_seed · v_uv · outColor<br/>Parameters: p_name; float / int / bool; color → linear vec3; enum → int index.<br/>Write functions and main() only. The renderer supplies uniforms and precision. Maximum 32 KiB; no while / do; literal for bounds ≤ 256. These checks are not a GPU sandbox.</p></details>
  <div className="ds-field"><span>Fragment shader</span><div className="ds-code"><div className="ds-lines" aria-hidden="true">{model.shader.split('\n').map((_,i)=>i+1).join('\n')}</div><Textarea aria-label="GLSL fragment shader" spellCheck={false} value={model.shader} onChange={e=>edit({shader:e.target.value})}/></div></div>
  <ParameterTable params={model.params} onChange={params=>{setValues(paramDefaults(params));edit({params});}}/>
  <div role="status" className="ds-muted">{status}</div>{error&&<pre role="alert" className="ds-mono" style={{whiteSpace:'pre-wrap'}}>{error}</pre>}
  {model.params.length>0&&<><h3>Preview controls</h3><Parameters params={model.params} values={values} onChange={(name,value)=>{generation.current++;setCheck(null);setValues(previous=>({...previous,[name]:value}));}}/></>}
  <div className="ds-fields"><div><h3>Current image</h3><div className="ds-mini-preview"><PreviewCanvas frame={frames?.current} label="Draft on current image"/></div></div><div><h3>Studio test image</h3><div className="ds-mini-preview"><PreviewCanvas frame={frames?.test} label="Draft on studio test image"/></div></div></div>
  <p className="ds-muted">Only a human can approve a checked draft. Edits invalidate approval readiness; the backend verifies the exact source hash.</p><div className="ds-row"><Button disabled={!check||check.token!==generation.current||Boolean(action)} onClick={approve}>{action==='approve'?'Approving…':'Approve tool'}</Button><Action disabled={!saved||Boolean(action)} onClick={()=>setConfirmDelete(true)}>Delete draft</Action></div>{confirmDelete&&<div className="ds-card"><p>Delete this saved draft? Approved tools are not affected.</p><div className="ds-row"><Action disabled={Boolean(action)} onClick={remove}>Confirm delete</Action><Action onClick={()=>setConfirmDelete(false)}>Cancel</Action></div></div>}
 </section>;
}
function DraftsPanel({catalog,service,doc,onRefresh}) {
 const [editing,setEditing]=useState(null);
 return editing?<DraftEditor key={editing==='new'?'new':editing.manifest.id} entry={editing==='new'?null:editing} service={service} doc={doc} onRefresh={onRefresh} onClose={()=>setEditing(null)}/>:<section className="ds-fields"><div className="ds-heading"><h3>Your shader tools</h3><Action onClick={()=>setEditing('new')}>New tool</Action></div><p className="ds-muted">Create manually, or edit an agent-created draft. Drafts never enter the operation stack until you approve them.</p>{catalog.drafts.length?catalog.drafts.map(entry=><div className="ds-card" key={entry.manifest.id}><div className="ds-heading"><h3>{entry.manifest.name}</h3><Action onClick={()=>setEditing(entry)}>Edit</Action></div><p className="ds-muted">{entry.manifest.description||'Draft shader tool'}</p><span className="ds-number">{entry.check?.ok?'Checked · awaiting human approval':'Needs compile check'}</span></div>):<Message>No drafts yet. Make your first tool with New tool.</Message>}</section>;
}

function ExportActions({service,ctx,doc,onError}) {
 const [download,setDownload]=useState(null),[busy,setBusy]=useState(''),[library,setLibrary]=useState(null),[hint,setHint]=useState('');
 const current=useRef(null),url=useRef(null);
 current.current=doc;
 useEffect(()=>{setDownload(null);setLibrary(null);setBusy('');setHint('');if(url.current){URL.revokeObjectURL(url.current);url.current=null;}return()=>{if(url.current){URL.revokeObjectURL(url.current);url.current=null;}};},[doc?.id,doc?.revision]);
 async function prepare(){const target=doc;setBusy('client');setHint('Rendering full-resolution PNG on this computer…');try {const result=await service.renderProject(target,{kind:'export'});if(current.current!==target)return;const href=URL.createObjectURL(result.blob);if(url.current)URL.revokeObjectURL(url.current);url.current=href;setDownload({href,width:result.width,height:result.height});setHint('Ready. Click Save as… to open the native save dialog on this computer.');}catch(e){if(current.current===target){onError(e);setHint('Client export failed. You can try Save to library as a separate gateway export.');}}finally{if(current.current===target)setBusy('');}}
 async function saveLibrary(){const target=doc;setBusy('gateway');try{const result=await service.saveLibrary(target);if(current.current===target){setLibrary(result);setHint('PNG saved in the library on the gateway, not necessarily this computer.');}}catch(e){if(current.current===target)onError(e);}finally{if(current.current===target)setBusy('');}}
 useEffect(()=>()=>{current.current=null;},[]);
 const path=library?.path||library?.stored_path||library?.receipt?.path;
 return <section className="ds-upload"><div className="ds-row"><Action disabled={!doc||Boolean(busy)} onClick={prepare}>{busy==='client'?'Preparing PNG…':'Prepare PNG'}</Action>{download&&<a href={download.href} download={`design-studio-r${doc.revision}.png`}>Save as…</a>}<Action disabled={!doc||Boolean(busy)} onClick={saveLibrary}>{busy==='gateway'?'Saving…':'Save to library'}</Action></div>{(hint||download)&&<p className="ds-muted" role="status">{hint}{download&&` ${download.width} × ${download.height} pixels.`}</p>}{path&&<div className="ds-muted"><span className="ds-mono">Gateway: {path}</span><div className="ds-row"><Action onClick={()=>ctx.os.writeClipboard(path)}>Copy path</Action><Action onClick={async()=>{const revealed=await ctx.os.revealPath(path);if(!revealed)setHint('This gateway path is not accessible on this computer. Use client Save as for a local file.');}}>Reveal (local gateway only)</Action></div></div>}</section>;
}

export function StudioPage({service,ctx}) {
 const [doc,setDoc]=useState(null),[catalog,setCatalog]=useState({tools:[],recipes:[],drafts:[]});
 const docRef=useRef(null),channel=useRef(null),life=useRef(null),uploadInput=useRef(null),importing=useRef(false),uploadTask=useRef(null);
 const [theme,setTheme]=useState(()=>ctx.storage.get('theme','native'));
 const [selected,setSelected]=useState(null),[tab,setTab]=useState('tools'),[frame,setFrame]=useState(null),[before,setBefore]=useState(null),[comparing,setComparing]=useState(false),[zoom,setZoom]=useState('fit');
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[rendering,setRendering]=useState(false),[busy,setBusy]=useState(''),[progress,setProgress]=useState(null),[drag,setDrag]=useState(false);
 const stateQuery=useQuery({queryKey:[ctx.source||'hermes-design-studio',service.metadata().run_id,'manual-state'],queryFn:()=>service.getState(),refetchInterval:2500,retry:1});
 function publish(document){if(!document)return;const current=docRef.current;if(current?.id===document.id&&current.revision>=document.revision)return;docRef.current=document;setDoc(document);}
 function accept(state){if(!state)return;publish(state.document);if(state.catalog)setCatalog(state.catalog);}
 async function refresh(){const state=await service.getState();if(!life.current?.signal.aborted)accept(state);return state;}
 function fail(e){if(!life.current?.signal.aborted)setError(String(e.message||e));}
 function send(commands,gesture){return channel.current?.send(commands,gesture).catch(fail);}
 function history(kind){return channel.current?.action(`/history/${kind}`).catch(fail);}
 async function importFile(file) {
  if(!file||importing.current||!docRef.current)return;
  const controller=new AbortController();uploadTask.current=controller;
  const abort=()=>controller.abort();life.current.signal.addEventListener('abort',abort,{once:true});
  importing.current=true;setBusy('Decoding image…');setError('');setProgress(null);setComparing(false);
  try {
   await importImage(file,{signal:controller.signal,maxTextureSize:service.renderer.maxTextureSize,
    decode:f=>createImageBitmap(f),show:local=>{setFrame(local);setZoom('fit');setNotice('Local preview — uploading PNG to the gateway before applying it to the project.');},
    encode:async bitmap=>{setBusy('Encoding PNG…');const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const c=canvas.getContext('2d');if(!c)throw new Error('Canvas 2D is unavailable');c.drawImage(bitmap,0,0);return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG encoding failed')),'image/png'));},
    upload:png=>{setBusy('Uploading image…');return uploadChunks(png,{rest:service.rest,signal:controller.signal,onProgress:p=>{if(!controller.signal.aborted)setProgress(p);}});},
    send:commands=>channel.current.send(commands)});
   if(!controller.signal.aborted)setNotice('Image imported and saved on the gateway.');
  }catch(e){if(!controller.signal.aborted)fail(new Error(`${e.message||e}\nThe local preview is not an applied project source if import failed. OAuth connections do not support uploads; connect using a token and retry. Gateway-path imports refer to the server, not this computer.`));}
  finally {life.current?.signal.removeEventListener('abort',abort);importing.current=false;if(!life.current?.signal.aborted){setBusy('');setProgress(null);}uploadTask.current=null;}
 }
 useEffect(()=>{accept(stateQuery.data);},[stateQuery.data]);
 useEffect(()=>{
  const controller=new AbortController();life.current=controller;service.page(true);
  const stop=()=>controller.abort();service.signal.addEventListener('abort',stop,{once:true});
  const transport=createCommandChannel({rest:service.rest,getDocument:()=>docRef.current,onDocument:publish,refresh:()=>service.getState(),onConflict:()=>{setError('The project changed elsewhere. Loaded the current revision; your edit was not replayed. Review and try again.');void stateQuery.refetch();}});channel.current=transport;
  const keys=[['undo','mod+z'],['redo','mod+shift+z']].map(([kind,key])=>ctx.register({id:`studio-${kind}`,area:KEYBINDS_AREA,data:{id:`design-studio.${kind}`,label:`Design Studio: ${kind}`,category:'view',defaults:[key],run:()=>{if(!controller.signal.aborted&&docRef.current)void history(kind);}}}));
  return()=>{controller.abort();transport.dispose();keys.forEach(dispose=>dispose());service.signal.removeEventListener('abort',stop);service.page(false);};
 },[service,ctx]);
 useEffect(()=>{
  if(!doc)return;let live=true;setRendering(true);
   const timer=setTimeout(()=>{service.renderProject(doc,{kind:'preview'}).then(result=>{if(live){setFrame(result);setNotice('');}}).catch(e=>live&&fail(e)).finally(()=>live&&setRendering(false));},300);
  return()=>{live=false;clearTimeout(timer);};
 },[doc,service]);
 useEffect(()=>{
  if(!doc)return;let live=true;
  service.renderProject({...doc,stack:[]},{kind:'preview',comparison:true}).then(result=>live&&setBefore(result)).catch(e=>live&&fail(e));
  return()=>{live=false;};
 },[doc?.id,doc?.source?.asset,service]);
 const node=doc?.stack.find(n=>n.uid===selected),tool=catalog.tools.find(t=>t.ref===node?.tool);
 const shownFrame=comparing?before:frame;
 return <main className="hds" data-theme={theme==='minimal'?'minimal':'native'}><style>{CSS}</style>
  <header className="ds-top"><div className="ds-brand"><span className="ds-eyebrow">Hermes · creative workspace</span><h1>Design Studio</h1></div>
   <div className="ds-row"><Action disabled={!doc||Boolean(busy)} onClick={()=>channel.current?.action('/project/new').catch(fail)}>New project</Action><Action disabled={!doc} onClick={()=>history('undo')}>Undo</Action><Action disabled={!doc} onClick={()=>history('redo')}>Redo</Action></div>
   <NativeSelect label="Interface theme" value={theme} onChange={value=>{setTheme(value);ctx.storage.set('theme',value);}}><option value="native">Hermes Native</option><option value="minimal">Minimal</option></NativeSelect>
   <Action onClick={()=>host.navigate('/design-studio/diagnostics')}>Diagnostics ↗</Action>
  </header>
  {(error||stateQuery.error)&&<div className="ds-alert" role="alert"><Action aria-label="Dismiss error" onClick={()=>setError('')}>Dismiss</Action>{error||String(stateQuery.error)}</div>}
  {notice&&<div className="ds-alert" role="status">{notice}</div>}
  <div className="ds-columns">
   <aside className="ds-panel ds-left" aria-label="Operation stack"><div className="ds-heading"><h2>Operations</h2><span className="ds-count">{String(doc?.stack.length||0).padStart(2,'0')}</span></div><p className="ds-muted">Applied in order, top to bottom.</p>
    {!doc?<Message>{stateQuery.isLoading?'Loading project…':'Project unavailable. Check the gateway connection.'}<Action onClick={()=>stateQuery.refetch()}>Retry</Action></Message>:!doc.stack.length?<Message><strong>A clean starting point</strong><span>Add a tool from the right to begin. Every operation stays editable.</span></Message>:<div className="ds-stack">{doc.stack.map((n,index)=>{const t=catalog.tools.find(t=>t.ref===n.tool);return <div key={n.uid} className="ds-node" data-selected={selected===n.uid}><div className="ds-row"><span className="ds-number">{String(index+1).padStart(2,'0')}</span><button className="ds-node-title" onClick={()=>setSelected(n.uid)}><span>{t?.manifest.name||n.tool}</span></button><input type="checkbox" aria-label={`Enable ${t?.manifest.name||n.tool}`} checked={n.enabled} onChange={e=>send([{type:'set_node',uid:n.uid,enabled:e.target.checked}])}/></div><div className="ds-row ds-space"><span className="ds-muted">{Math.round(n.opacity*100)}% · {n.blend}</span><div className="ds-row"><Action aria-label="Move operation up" disabled={index===0} onClick={()=>send([{type:'move_node',uid:n.uid,index:index-1}])}>↑</Action><Action aria-label="Move operation down" disabled={index===doc.stack.length-1} onClick={()=>send([{type:'move_node',uid:n.uid,index:index+1}])}>↓</Action><Action aria-label="Remove operation" onClick={()=>send([{type:'remove_node',uid:n.uid}])}>×</Action></div></div></div>;})}</div>}
    <div className="ds-bottom">{doc&&<section className="ds-fields"><Parameter param={{name:'seed',label:'Seed',type:'int',min:0,max:16777215,default:0}} value={doc.seed} onChange={(value,gesture)=>send([{type:'set_seed',seed:value}],gesture)}/><Action onClick={()=>send([{type:'set_seed',seed:(doc.seed+1)%16777216}])}>Next seed</Action></section>}<p className="ds-muted">{doc?`Revision ${doc.revision}`:'No project loaded'}</p><p className="ds-muted">Edits are saved on the gateway. New project retains earlier project files.</p></div>
   </aside>
   <section className="ds-canvas-column" aria-label="Image workspace"><div className="ds-canvas-toolbar"><div className="ds-row"><Action onClick={()=>uploadInput.current?.click()} disabled={Boolean(busy)}>Upload image</Action><input ref={uploadInput} hidden type="file" accept="image/*" disabled={Boolean(busy)||!doc} onChange={e=>{const file=e.target.files?.[0];e.target.value='';void importFile(file);}}/></div><div className="ds-row"><Action aria-pressed={zoom==='fit'} onClick={()=>setZoom('fit')}>Fit</Action><Action aria-pressed={zoom==='100'} onClick={()=>setZoom('100')}>100%</Action><Action disabled={!before} onPointerDown={e=>{e.currentTarget.setPointerCapture?.(e.pointerId);setComparing(true);}} onPointerUp={()=>setComparing(false)} onPointerCancel={()=>setComparing(false)} onLostPointerCapture={()=>setComparing(false)} onKeyDown={e=>{if(e.key===' '){e.preventDefault();setComparing(true);}}} onKeyUp={()=>setComparing(false)} onBlur={()=>setComparing(false)}>Hold before / after</Action></div></div>
    <div className="ds-viewport" tabIndex={0} aria-label="Canvas. Hold backslash to compare" data-drag={drag} onDragOver={e=>{e.preventDefault();if(!busy)setDrag(true);}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget))setDrag(false);}} onDrop={e=>{e.preventDefault();setDrag(false);void importFile(e.dataTransfer.files?.[0]);}} onKeyDown={e=>{if(e.key==='\\'&&!e.repeat){e.preventDefault();setComparing(true);}}} onKeyUp={e=>{if(e.key==='\\')setComparing(false);}} onBlur={()=>setComparing(false)}><PreviewCanvas frame={shownFrame} zoom={zoom} label={comparing?'Original image':'Project preview'}/></div>
    {busy&&<div className="ds-alert" role="status">{busy}{progress&&<><progress value={progress.bytes_received} max={progress.bytes_total}/><small>{progress.index+1} / {progress.total} chunks · {progress.bytes_received.toLocaleString()} / {progress.bytes_total.toLocaleString()} bytes</small></>}<Action onClick={()=>{uploadTask.current?.abort();setNotice('Import cancelled. Any local preview has not replaced the project source.');}}>Cancel import</Action></div>}
    <div style={{padding:'10px 14px',borderTop:'1px solid var(--ui-stroke-secondary)'}}><ExportActions service={service} ctx={ctx} doc={doc} onError={fail}/><p className="ds-muted">Upload / Save as: this computer. Library and agent file paths: gateway.</p></div>
    <div className="ds-canvas-foot"><span>{doc?.source?`${doc.source.w} × ${doc.source.h} · source image`:'Studio test image · upload to use your own'}</span><span>{rendering?'Rendering…':frame?`${frame.width} × ${frame.height} preview`:'Renderer waiting'}</span></div>
   </section>
   <aside className="ds-panel ds-right" aria-label="Tool controls and library">
    <section className="ds-fields"><div className="ds-heading"><h2>{tool?.manifest.name||'Parameters'}</h2>{node&&<span className="ds-count">Selected operation</span>}</div>{node?<><Parameters params={tool?.manifest.params} values={node.params} onChange={(name,value,gesture)=>send([{type:'set_params',uid:node.uid,params:{[name]:value}}],gesture)}/><Parameter param={{name:'opacity',label:'Opacity',type:'float',min:0,max:1,default:1}} value={node.opacity} onChange={(value,gesture)=>send([{type:'set_node',uid:node.uid,opacity:value}],gesture)}/><label className="ds-field"><span>Blend mode</span><NativeSelect label="Blend mode" value={node.blend} onChange={blend=>send([{type:'set_node',uid:node.uid,blend}])}>{['normal','multiply','screen','overlay'].map(b=><option key={b}>{b}</option>)}</NativeSelect></label></>:<p className="ds-muted">Select an operation in the stack to adjust its controls.</p>}</section>
    <div className="ds-divider"/><nav className="ds-tabs" role="tablist" aria-label="Studio library">{['tools','recipes','drafts'].map(t=><Action key={t} role="tab" aria-selected={tab===t} onClick={()=>setTab(t)}>{t[0].toUpperCase()+t.slice(1)}</Action>)}</nav>
    <div role="tabpanel">{tab==='tools'?<div className="ds-fields">{catalog.tools.length?catalog.tools.map(t=><div className="ds-card" key={t.ref}><div className="ds-heading"><h3>{t.manifest.name}</h3><Action aria-label={`Add ${t.manifest.name}`} disabled={!doc} onClick={()=>send([{type:'add_node',tool:t.ref}])}>+ Add</Action></div><p className="ds-muted">{t.manifest.description||'Add this non-destructive operation to your stack.'}</p><span className="ds-number">{t.status==='builtin'?'Built-in':'Your tool'} · v{t.manifest.version||1} · {(t.manifest.params||[]).length} controls</span></div>):<Message>No tools loaded. Retry when the gateway is connected.<Action onClick={()=>refresh().catch(fail)}>Refresh catalog</Action></Message>}</div>:tab==='drafts'?<DraftsPanel catalog={catalog} service={service} doc={doc} onRefresh={refresh}/>:<RecipesPanel catalog={catalog} service={service} doc={doc} onRefresh={refresh} onApply={id=>channel.current.action('/recipes/apply',{id})} onParam={(uid,name,value,gesture)=>send([{type:'set_params',uid,params:{[name]:value}}],gesture)}/>}</div>
   </aside>
  </div>
 </main>;
}

export function DiagnosticsPage({service,ctx}) {
 const [report,setReport]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const live=useRef(false);
 useEffect(()=>{live.current=true;service.page(true);return()=>{live.current=false;service.page(false);};},[service]);
 async function run(){setBusy(true);setError('');try{const result=await service.diagnostics();if(live.current)setReport(result);}catch(e){if(live.current)setError(String(e));}finally{if(live.current)setBusy(false);}}
 return <main className="hds" data-theme={ctx.storage.get('theme','native')}><style>{CSS}</style><header className="ds-top"><div className="ds-brand"><span className="ds-eyebrow">Hermes Design Studio</span><h1>Renderer diagnostics</h1></div><Action onClick={()=>host.navigate('/design-studio')}>← Back to Studio</Action><Button disabled={busy} onClick={run}>{busy?'Checking pixels…':'Run diagnostics'}</Button></header><section className="ds-panel"><p className="ds-muted">Runs the actual built-in shaders on fixed fixtures and compares rendered pixels with independent expectations. Results are saved to diagnostics.json on the gateway.</p>{error&&<div role="alert" className="ds-alert">{error}</div>}{!report?<Message>No checks run yet. Start diagnostics to test this Desktop GPU.</Message>:<><h2>{report.pass?'All checks passed':'One or more checks failed'}</h2><table><thead><tr><th>Tool</th><th>Result</th><th>Details</th></tr></thead><tbody>{(report.checks||[]).map((c,i)=><tr key={i}><td>{c.tool||c.name}</td><td>{c.pass?'PASS':'FAIL'}</td><td className="ds-mono">{c.error||JSON.stringify(c)}</td></tr>)}</tbody></table></>}</section></main>;
}
