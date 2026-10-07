import { diffText, type ProofreadResult } from '../shared/proofread';
export interface ReviewBlock { before: string; result: ProofreadResult; segment?: number; }
export function renderReview(root: HTMLElement, blocks: ReviewBlock[], select: (block: ReviewBlock, quote: string)=>void): void {
  root.replaceChildren();
  root.hidden = !blocks.length;
  if (!blocks.length) return;
  const heading=document.createElement('h3');heading.textContent='Результат вычитки';root.append(heading);
  const legend=document.createElement('p');legend.className='review-legend';legend.textContent='Зачёркнуто — удалено. Подчёркнуто — добавлено. Жёлтым — места для вашей проверки.';root.append(legend);
  const state=document.createElement('p');state.id='review-state';state.className='review-state';state.setAttribute('role','status');root.append(state);
  for(const block of blocks){
    const section=document.createElement('section');
    if(block.segment!==undefined){const label=document.createElement('h4');label.textContent=`Фраза ${block.segment+1}`;section.append(label);}
    const changes=document.createElement('details');changes.open=true;
    const summary=document.createElement('summary');summary.textContent=block.before===block.result.text?'Текст не изменён':'Что изменилось';changes.append(summary);
    const diff=document.createElement('div');diff.className='review-text';
    for(const part of diffText(block.before,block.result.text)){
      const span=document.createElement(part.kind==='add'?'ins':part.kind==='remove'?'del':'span');
      span.textContent=part.text;diff.append(span);
    }
    changes.append(diff);section.append(changes);
    if(block.result.issues.length){
      const title=document.createElement('h4');title.textContent='Нужно уточнить';section.append(title);
      const preview=document.createElement('div');preview.className='review-text review-uncertain';
      const ranges: {start:number;end:number}[]=[];
      for(const issue of block.result.issues){let start=0;while((start=block.result.text.indexOf(issue.quote,start))>=0){ranges.push({start,end:start+issue.quote.length});start+=issue.quote.length;}}
      ranges.sort((a,b)=>a.start-b.start);
      let cursor=0;
      for(const range of ranges){if(range.end<=cursor)continue;preview.append(document.createTextNode(block.result.text.slice(cursor,Math.max(cursor,range.start))));const mark=document.createElement('mark');mark.textContent=block.result.text.slice(Math.max(cursor,range.start),range.end);preview.append(mark);cursor=range.end;}
      preview.append(document.createTextNode(block.result.text.slice(cursor)));section.append(preview);
      for(const issue of block.result.issues){
        const card=document.createElement('div');card.className='review-issue';
        const quote=document.createElement('strong');quote.textContent=issue.quote;
        const reason=document.createElement('p');reason.textContent=issue.reason;
        const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent='Найти в редакторе';button.dataset.reviewSelect='true';button.addEventListener('click',()=>select(block,issue.quote));
        card.append(quote,reason,button);section.append(card);
      }
    }else{const note=document.createElement('p');note.textContent=block.result.reviewed?'Модель не отметила неоднозначных мест.':'Модель вернула только текст: замечания о неоднозначности недоступны.';section.append(note);}
    if(!block.result.reviewed && block.result.issues.length){const note=document.createElement('p');note.textContent='Часть замечаний не удалось привязать к тексту. Проверьте результат вручную.';section.append(note);}
    root.append(section);
  }
  const note=document.createElement('p');note.className='review-legend';note.textContent='Это отчёт последней вычитки в текущем окне. Замечания модели могут быть неполными. Исправляйте текст в редакторе ниже; отметки не попадают в копируемый текст.';root.append(note);
}
