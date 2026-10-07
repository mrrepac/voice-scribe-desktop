export interface ReviewIssue { quote: string; reason: string; }
/** plain: dictated text; selection: text selected in another application; review: with a report. */
export type ProofreadMode = 'plain' | 'review' | 'selection';
export interface ProofreadResult { text: string; issues: ReviewIssue[]; reviewed: boolean; }

export function parseProofreadResult(raw: string): ProofreadResult {
  const value = raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch {
    if (/^[{\[]/.test(value)) throw new Error('Модель вернула неполный отчёт. Исходный текст сохранён.');
    return { text: raw.trim(), issues: [], reviewed: false };
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Модель вернула некорректный отчёт.');
  const data = parsed as Record<string,unknown>;
  if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 100000 || !Array.isArray(data.issues)) throw new Error('Модель вернула некорректный отчёт.');
  const text = data.text.trim();
  const issues: ReviewIssue[] = [];
  let reviewed = true;
  for (const item of data.issues.slice(0,100)) {
    if (!item || typeof item.quote !== 'string' || !item.quote.trim() || typeof item.reason !== 'string' || !item.reason.trim() || !text.includes(item.quote)) { reviewed = false; continue; }
    if (!issues.some(issue=>issue.quote===item.quote && issue.reason===item.reason)) issues.push({quote:item.quote,reason:item.reason.slice(0,1500)});
  }
  if (data.issues.length > 100) reviewed = false;
  return {text,issues,reviewed};
}

/** Puts the selection's leading and trailing whitespace (such as a final line break) back around the corrected text. */
export function keepSurroundingSpace(original: string, corrected: string): string {
  const lead = /^\s*/.exec(original)![0], trail = original.slice(lead.length).match(/\s*$/)![0];
  return lead + corrected.trim() + trail;
}

export interface DiffPart { kind: 'same' | 'remove' | 'add'; text: string; }
/** Word/punctuation diff with a bounded matrix for long, heavily rewritten text. */
export function diffText(before: string, after: string): DiffPart[] {
  const tokenize = (text:string) => text.match(/[\p{L}\p{N}\p{M}_]+|\s+|[^\p{L}\p{N}\p{M}_\s]/gu) ?? [];
  const a=tokenize(before), b=tokenize(after);
  let start=0, end=0;
  while(start<a.length && start<b.length && a[start]===b[start])start++;
  while(end<a.length-start && end<b.length-start && a[a.length-1-end]===b[b.length-1-end])end++;
  const x=a.slice(start,a.length-end),y=b.slice(start,b.length-end);
  const parts: DiffPart[]=[];
  const push=(kind:DiffPart['kind'],text:string)=>{if(!text)return;const last=parts[parts.length-1];if(last?.kind===kind)last.text+=text;else parts.push({kind,text});};
  push('same',a.slice(0,start).join(''));
  if(x.length*y.length>1_000_000){push('remove',x.join(''));push('add',y.join(''));}
  else {
    const width=y.length+1;
    const table=new Uint32Array((x.length+1)*width);
    for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)table[i*width+j]=x[i]===y[j]?1+table[(i+1)*width+j+1]:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
    let i=0,j=0;
    while(i<x.length || j<y.length){
      if(i<x.length && j<y.length && x[i]===y[j]){push('same',x[i++]);j++;}
      else if(i<x.length && (j===y.length || table[(i+1)*width+j]>=table[i*width+j+1]))push('remove',x[i++]);
      else push('add',y[j++]);
    }
  }
  push('same',end?a.slice(a.length-end).join(''):'');
  return parts;
}
