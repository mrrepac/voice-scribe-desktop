import { parseProofreadResult, type ProofreadResult } from './proofread';
export interface ProofreadCue { id: number; text: string; }
export interface ProofreadBatch { cues: ProofreadCue[]; context: ProofreadCue[]; }
export interface ProofreadCueResult extends ProofreadResult { id: number; }

export function makeProofreadBatches(segments: {text: string}[]): ProofreadBatch[] {
  const batches: ProofreadBatch[]=[];
  for (let start=0; start<segments.length;) {
    let end=start, length=0;
    while(end<segments.length && end-start<24 && (end===start || length+segments[end].text.length<=10000)) length+=segments[end++].text.length;
    const cue=(index:number):ProofreadCue=>({id:index,text:segments[index].text});
    batches.push({cues:Array.from({length:end-start},(_,i)=>cue(start+i)),context:[...Array.from({length:Math.min(2,start)},(_,i)=>cue(start-Math.min(2,start)+i)),...Array.from({length:Math.min(2,segments.length-end)},(_,i)=>cue(end+i))]});
    start=end;
  }
  return batches;
}

export function validateBatch(raw: unknown): ProofreadBatch {
  const value=raw as ProofreadBatch;
  if (!value || !Array.isArray(value.cues) || !value.cues.length || value.cues.length>24 || !Array.isArray(value.context) || value.context.length>4) throw new Error('Некорректная группа фраз');
  const cues=[...value.cues,...value.context];
  if (cues.some(cue=>!cue || !Number.isInteger(cue.id) || cue.id<0 || typeof cue.text!=='string' || !cue.text.trim() || cue.text.length>20000) || new Set(cues.map(cue=>cue.id)).size!==cues.length || cues.reduce((sum,cue)=>sum+cue.text.length,0)>50000) throw new Error('Некорректные фразы для вычитки');
  return {cues:value.cues.map(({id,text})=>({id,text})),context:value.context.map(({id,text})=>({id,text}))};
}

export function parseBatchResult(raw: string, batch: ProofreadBatch): ProofreadCueResult[] {
  const text=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let value: {cues?: unknown};
  try { value=JSON.parse(text); } catch { throw new Error('Некорректный ответ вычитки. Исходный текст сохранён.'); }
  if (!value || !Array.isArray(value.cues) || value.cues.length!==batch.cues.length) throw new Error('Модель пропустила фразы. Исходный текст сохранён.');
  const rows=value.cues as {id:number;text:string;issues:unknown[]}[];
  if (new Set(rows.map(row=>row?.id)).size!==rows.length || rows.some(row=>!row || !batch.cues.some(cue=>cue.id===row.id) || typeof row.text!=='string' || !row.text.trim() || row.text.length>20000 || !Array.isArray(row.issues))) throw new Error('Модель изменила структуру фраз. Исходный текст сохранён.');
  return batch.cues.map(cue=>{
    const row=rows.find(row=>row.id===cue.id)!;
    return {...parseProofreadResult(JSON.stringify(row)),id:cue.id};
  });
}
