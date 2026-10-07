import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { diffText, parseProofreadResult } from '../src/shared/proofread';

test('diff preserves both exact texts, including punctuation, whitespace and Unicode',()=>{
  for(const [before,after] of [['превет мир','Привет, мир!'],['a a b','a b b'],['','text'],['text',''],['без изменений','без изменений'],['🙂 ёж\n\nпришол','🙂 Ёж\n\nпришёл.'],['one\t two','one two'],['a '.repeat(2000),'b '.repeat(2000)]]) {
    const parts=diffText(before,after);
    assert.equal(parts.filter(p=>p.kind!=='add').map(p=>p.text).join(''),before);
    assert.equal(parts.filter(p=>p.kind!=='remove').map(p=>p.text).join(''),after);
  }
});
test('structured review keeps only issues anchored in the corrected text',()=>{
  const result=parseProofreadResult(JSON.stringify({text:'Встреча с Сашей в пятницу.',issues:[{quote:'Сашей',reason:'Уточните имя.'},{quote:'несуществующий текст',reason:'Неясно.'}]}));
  assert.deepEqual(result.issues,[{quote:'Сашей',reason:'Уточните имя.'}]);
  assert.equal(result.reviewed,false);
});
test('fenced JSON is supported and plain text is explicitly marked as lacking a review',()=>{
  assert.deepEqual(parseProofreadResult('```json\n{"text":"Текст.","issues":[]}\n```'),{text:'Текст.',issues:[],reviewed:true});
  assert.equal(parseProofreadResult('Обычный ответ.').reviewed,false);
});
test('malformed or empty structured responses never become replacement text',()=>{
  for(const raw of ['{"text":','{"text":"","issues":[]}','{"text":"Текст"}','null','[1,2]'])assert.throws(()=>parseProofreadResult(raw));
});
test('repeated quotes and model markup remain literal data',()=>{
  const issue={quote:'<b>имя</b>',reason:'<script>alert(1)</script>'};
  const parsed=parseProofreadResult(JSON.stringify({text:'<b>имя</b>, <b>имя</b>',issues:[issue,issue]}));
  assert.deepEqual(parsed.issues,[issue]);
});
