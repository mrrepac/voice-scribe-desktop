import type { Delivery } from '../shared/contracts';

export function deliveryMessage(delivery: Delivery, hasTarget: boolean, enterRequested: boolean): string {
  const reasons: Record<string, string> = {
    'target-changed': 'Активное окно изменилось.',
    'modifiers-held': 'Клавиши Ctrl, Shift, Alt или Win оставались нажаты.',
    'input-blocked': 'Windows или приложение заблокировали автоматическую вставку.',
    'enter-blocked': 'Приложение не приняло клавишу Enter.',
    'no-target': 'Окно для вставки недоступно.',
    'invalid-target': 'Окно для вставки недоступно.',
    'own-window': 'Открыто окно Voice Scribe.',
    'cancelled': 'Автоматическая вставка отменена.',
  };
  if (delivery.status === 'inserted') {
    if (enterRequested && delivery.entered) return 'Текст вставлен в выбранное поле с Enter.';
    if (enterRequested) return `Текст вставлен. Enter не отправлен. ${reasons[delivery.reason ?? ''] ?? 'Нажмите Enter вручную, если нужно.'}`;
    return 'Текст вставлен в выбранное поле.';
  }
  if (!hasTarget) return 'Текст скопирован в буфер обмена. Вставьте его с помощью Ctrl + V.';
  return `Текст скопирован. ${reasons[delivery.reason ?? ''] ?? 'Автоматическая вставка недоступна.'} Нажмите Ctrl + V в нужном поле.`;
}
