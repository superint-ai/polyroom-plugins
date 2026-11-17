const turnTimeZone = 'UTC';
const answeringReasons = new Set(['mention', 'direct']);
const controlCharacters = /\p{Cc}/gu;
const invisibleFormatCharacters = /[\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

export const systemClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function sanitize(value) {
  return String(value)
    .replace(controlCharacters, ' ')
    .replace(invisibleFormatCharacters, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replaceAll('<', '‹')
    .replaceAll('>', '›');
}

export const statusTexts = {
  authRejected: (handle) => `polyroom long polling stopped: the token of @${handle} was refused. Check POLYROOM_MCP_AUTHORIZATION in the polyroom-long-polling MCP entry of the profile's .claude.json and reopen the session.`,
  stopped: (problems) => `polyroom long polling stopped: ${problems.join(' ')}`,
  queryRejected: (code) => `the chat MCP refused the notices query (${sanitize(code)}). Check POLYROOM_POLL_WAIT_SECONDS and POLYROOM_POLL_LIMIT in the .env of apps/mcp-long-polling: the wait cannot exceed MCP_NOTIFICATIONS_WAIT_MAX_SECONDS and the limit cannot exceed MCP_NOTIFICATIONS_PAGE_MAX_LIMIT of the chat MCP (nor NOTIFICATIONS_PAGE_MAX_LIMIT of the backend). Then reopen the session.`,
  lockFailed: (handle, code, retryMs) => `polyroom long polling has no lock: the lock of @${handle} could not be created (${sanitize(code)}). The session retries every ${retryMs} ms (POLYROOM_LOCK_RETRY_MS).`,
};

export const noticeLocales = Object.freeze(['pt-BR', 'en-US', 'es']);
export const fallbackNoticeLocale = 'en-US';
export const noticeLocaleOf = (value) => noticeLocales.find((locale) => locale === value) ?? null;

const catalogs = {
  'pt-BR': {
    place: (position, total) => ` (${position} de ${total})`,
    debateExpired: (place, clock) => `O prazo da sua vez no debate${place} venceu às ${clock}. `
      + 'Confira o debate desta mensagem com chat_messages antes de responder: a vez pode já ter passado ao próximo.',
    debateTurn: (place, clock) => `É a sua vez no debate${place}${clock ? `, até ${clock}` : ''}. `
      + 'Leia a conversa desde esta mensagem e responda a ela (replyTo) sem repetir o que já foi dito; sem nada a acrescentar, reaja a ela com chat_react para passar a vez. '
      + 'Qualquer reação a ela na sua vez passa a vez, mesmo um emoji repetido: se vai responder, não reaja.',
    everyone: 'Todos respondem: você pode responder direto, sem reservar a resposta.',
    debateWait: 'Mensagem em debate: responda só quando chegar o aviso da sua vez.',
    cardLeads: {
      card_assigned: { by: (sender, card) => `${sender} atribuiu você ao cartão ${card}`, alone: (card) => `Você foi atribuído ao cartão ${card}` },
      card_comment_mention: { by: (sender, card) => `${sender} mencionou você num comentário do cartão ${card}`, alone: (card) => `Você foi mencionado num comentário do cartão ${card}` },
      card_description_mention: { by: (sender, card) => `${sender} mencionou você na descrição do cartão ${card}`, alone: (card) => `Você foi mencionado na descrição do cartão ${card}` },
      card_returned: { by: (sender, card) => `${sender} devolveu da aprovação o cartão ${card}`, alone: (card) => `O cartão ${card} foi devolvido da aprovação` },
      card_approved: { by: (sender, card) => `${sender} aprovou o cartão ${card}, cuja aprovação você solicitou`, alone: (card) => `O cartão ${card}, cuja aprovação você solicitou, foi aprovado` },
    },
    otherCardLead: { by: (sender, card) => `${sender} mandou um aviso sobre o cartão ${card}`, alone: (card) => `Você recebeu um aviso sobre o cartão ${card}` },
    decisionLeads: {
      decision_proposed: { by: (sender, room) => `${sender} pediu a sua aprovação para uma decisão ${room}`, alone: (room) => `Pediram a sua aprovação para uma decisão ${room}` },
      decision_reviewed: { by: (sender, room) => `${sender} revisou uma decisão da qual você participa, ${room}`, alone: (room) => `Uma decisão da qual você participa foi revisada ${room}` },
      decision_approvers_changed: { by: (sender, room) => `${sender} incluiu você entre os aprovadores de decisões ${room}, que tem decisões esperando aprovação`,
        alone: (room) => `Você foi incluído entre os aprovadores de decisões ${room}, que tem decisões esperando aprovação` },
    },
    otherDecisionLead: { by: (sender, room) => `${sender} mandou um aviso sobre uma decisão ${room}`, alone: (room) => `Você recebeu um aviso sobre uma decisão ${room}` },
    pendingLeads: {
      pending_assigned: { by: (sender, room) => `${sender} abriu uma pendência para você sobre uma mensagem ${room}`, alone: (room) => `Abriram uma pendência para você sobre uma mensagem ${room}` },
    },
    otherPendingLead: { by: (sender, room) => `${sender} mandou um aviso sobre uma pendência ${room}`, alone: (room) => `Você recebeu um aviso sobre uma pendência ${room}` },
    batchLeads: {
      closed: (room, answered, total) => `Sua solicitação de respostas ${room} foi encerrada: ${answered === 0 ? 'nenhum agente respondeu ou reagiu'
        : `${answered} de ${total} ${total === 1 ? 'agente' : 'agentes'} ${answered === 1 ? 'respondeu ou reagiu' : 'responderam ou reagiram'}`}`,
      debate: (room, answered, total) => `Seu debate ${room} terminou: ${answered === 0 ? 'nenhum agente falou'
        : `${answered} de ${total} ${total === 1 ? 'agente' : 'agentes'} ${answered === 1 ? 'falou' : 'falaram'}`}`,
      answered: (names) => `Respostas e reações: ${names}`,
      spoke: (names) => `Falas no debate: ${names}`,
      stopWaiting: 'Não continue aguardando respostas a esta solicitação encerrada. Respostas posteriores ainda podem chegar.',
      replied: (name, room) => `${name} respondeu à sua solicitação de respostas ${room} depois do encerramento`,
      reacted: (name, emoji, room) => `${name} reagiu com ${emoji} à sua solicitação de respostas ${room} depois do encerramento`,
      other: (room) => `Você recebeu um aviso sobre uma solicitação de respostas ${room}. Consulte a mensagem de origem e as respostas posteriores antes de agir`,
    },
    batchMembers: {
      missed: (name) => `Sem resposta nem reação de ${name} até o prazo.`,
      undelivered: (name, reason) => `Sem entrega confirmada a ${name} até o prazo${reason ? ` (código de entrega: ${reason})` : ''}.`,
      removed: (name) => `${name} saiu da sala.`,
      stopped: (name) => `${name} não respondeu nem reagiu antes do encerramento.`,
      debate_cancelled: (name) => `${name} não falou antes do encerramento do debate.`,
      declined: (name, reason) => `${name} recusou o pedido de resposta.${reason ? ` Motivo informado: ${reason}.` : ''}`,
      passed: (name) => `${name} passou a vez.`,
    },
    noReference: 'sem referência',
    resend: (attempt) => `(reenvio ${attempt})`,
    firstAction: 'Antes de agir, chame chat_processing (eventIds = [event_id]); ao terminar, ou se nada for preciso, chat_ack.',
    resendAction: 'Se ainda está trabalhando neste aviso, chame chat_processing (eventIds = [event_id]); se já terminou ou nada falta, chat_ack; se está travado, chat_suspend.',
    inRoom: (name) => `em ${name}`,
    inRoomId: (id) => `na sala ${id}`,
    messageLeads: {
      mention: { by: (sender, room) => `${sender} mencionou você ${room}`, alone: (room) => `Você recebeu uma menção ${room}` },
      direct: { by: (sender, room) => `${sender} mandou uma mensagem direta ${room}`, alone: (room) => `Você recebeu uma mensagem direta ${room}` },
      reply: { by: (sender, room) => `${sender} respondeu a uma mensagem sua ${room}`, alone: (room) => `Você recebeu uma resposta ${room}` },
      edited: { by: (sender, room) => `${sender} editou uma mensagem da qual você foi avisado ${room}; leia de novo com chat_messages antes de agir`, alone: (room) => `Uma mensagem da qual você foi avisado foi editada ${room}; leia de novo com chat_messages antes de agir` },
      deleted: { by: (sender, room) => `${sender} excluiu uma mensagem que você leu ${room}; o texto e os anexos sumiram, então não aja mais sobre ela`, alone: (room) => `Uma mensagem que você leu foi excluída ${room}; o texto e os anexos sumiram, então não aja mais sobre ela` },
    },
    claimReleased: (room) => `Uma pessoa liberou a resposta a uma mensagem que menciona você ${room}; ninguém a reservou agora. Se ainda for sua, reserve com chat_reply_claim e responda`,
    otherLead: { by: (sender, room) => `${sender} mandou um aviso ${room}`, alone: (room) => `Você recebeu um aviso ${room}` },
    messageNumber: (id) => `mensagem ${id}`,
    lockBusy: (handle) => `Outra sessão já recebe os avisos de @${handle}. Esta assume se aquela fechar.`,
    lockAcquired: (handle) => `Esta sessão passou a receber os avisos de @${handle}.`,
    suspended: {
      delivery_attempts_exhausted: (ids) => `Os avisos ${ids} foram reenviados até o limite sem confirmação e ficaram suspensos. Eles não voltam sozinhos: confira o histórico e use chat_retry ou chat_ack.`,
      processing_lease_expired: (ids) => `O prazo de processamento dos avisos ${ids} venceu e eles ficaram suspensos. Eles não voltam sozinhos: confira o histórico e use chat_retry ou chat_ack.`,
      interrupted_processing: (ids) => `A sessão anterior parou no meio dos avisos ${ids}, que ficaram suspensos. Confira o histórico antes de usar chat_retry ou chat_ack.`,
    },
    queueFull: (count, max) => `A fila tem ${count} avisos e chegou ao POLYROOM_QUEUE_MAX (${max}): o polling parou de buscar avisos novos até ela esvaziar. Avisos suspensos contam na fila; confira-os com chat_polling_status e use chat_retry ou chat_ack.`,
  },
  'en-US': {
    place: (position, total) => ` (${position} of ${total})`,
    debateExpired: (place, clock) => `Your turn in the debate${place} expired at ${clock}. `
      + 'Check the debate of this message with chat_messages before answering: the turn may already have passed to the next one.',
    debateTurn: (place, clock) => `It is your turn in the debate${place}${clock ? `, until ${clock}` : ''}. `
      + 'Read the conversation since this message and reply to it (replyTo) without repeating what was already said; with nothing to add, react to it with chat_react to pass your turn. '
      + 'Any reaction to it during your turn passes the turn, even a repeated emoji: if you are going to answer, do not react.',
    everyone: 'Everyone answers: you can reply directly, without claiming the reply.',
    debateWait: 'Message in a debate: answer only when the notice of your turn arrives.',
    cardLeads: {
      card_assigned: { by: (sender, card) => `${sender} assigned you to card ${card}`, alone: (card) => `You were assigned to card ${card}` },
      card_comment_mention: { by: (sender, card) => `${sender} mentioned you in a comment on card ${card}`, alone: (card) => `You were mentioned in a comment on card ${card}` },
      card_description_mention: { by: (sender, card) => `${sender} mentioned you in the description of card ${card}`, alone: (card) => `You were mentioned in the description of card ${card}` },
      card_returned: { by: (sender, card) => `${sender} sent card ${card} back from approval`, alone: (card) => `Card ${card} was sent back from approval` },
      card_approved: { by: (sender, card) => `${sender} approved card ${card}, which you submitted for approval`, alone: (card) => `The card you submitted for approval (${card}) was approved` },
    },
    otherCardLead: { by: (sender, card) => `${sender} sent a notice about card ${card}`, alone: (card) => `You received a notice about card ${card}` },
    decisionLeads: {
      decision_proposed: { by: (sender, room) => `${sender} asked you to approve a decision ${room}`, alone: (room) => `You were asked to approve a decision ${room}` },
      decision_reviewed: { by: (sender, room) => `${sender} reviewed a decision you take part in, ${room}`, alone: (room) => `A decision you take part in was reviewed ${room}` },
      decision_approvers_changed: { by: (sender, room) => `${sender} added you to the decision approvers ${room}, which has decisions waiting for approval`,
        alone: (room) => `You were added to the decision approvers ${room}, which has decisions waiting for approval` },
    },
    otherDecisionLead: { by: (sender, room) => `${sender} sent a notice about a decision ${room}`, alone: (room) => `You received a notice about a decision ${room}` },
    pendingLeads: {
      pending_assigned: { by: (sender, room) => `${sender} opened a pending item for you on a message ${room}`, alone: (room) => `A pending item was opened for you on a message ${room}` },
    },
    otherPendingLead: { by: (sender, room) => `${sender} sent a notice about a pending item ${room}`, alone: (room) => `You received a notice about a pending item ${room}` },
    batchLeads: {
      closed: (room, answered, total) => `Your request for replies ${room} closed: ${answered === 0 ? 'no agents' : `${answered} of ${total} ${total === 1 ? 'agent' : 'agents'}`} replied or reacted`,
      debate: (room, answered, total) => `Your debate ${room} ended: ${answered === 0 ? 'no agents' : `${answered} of ${total} ${total === 1 ? 'agent' : 'agents'}`} spoke`,
      answered: (names) => `Replies and reactions: ${names}`,
      spoke: (names) => `Debate contributions: ${names}`,
      stopWaiting: 'Do not keep waiting for replies to this closed request. Later replies may still arrive.',
      replied: (name, room) => `${name} answered your request for replies ${room} after it closed`,
      reacted: (name, emoji, room) => `${name} reacted with ${emoji} to your request for replies ${room} after it closed`,
      other: (room) => `You received a notice about a request for replies ${room}. Read the source message and later replies before acting`,
    },
    batchMembers: {
      missed: (name) => `No reply or reaction from ${name} before the deadline.`,
      undelivered: (name, reason) => `No confirmed delivery to ${name} before the deadline${reason ? ` (delivery code: ${reason})` : ''}.`,
      removed: (name) => `${name} left the room.`,
      stopped: (name) => `${name} did not reply or react before the request closed.`,
      debate_cancelled: (name) => `${name} did not speak before the debate ended.`,
      declined: (name, reason) => `${name} declined the request for a reply.${reason ? ` Reported reason: ${reason}.` : ''}`,
      passed: (name) => `${name} passed their turn.`,
    },
    noReference: 'no reference',
    resend: (attempt) => `(resend ${attempt})`,
    firstAction: 'Before acting on it, call chat_processing (eventIds = [event_id]); when done, or if nothing is needed, chat_ack.',
    resendAction: 'If you are still working on this notice, call chat_processing (eventIds = [event_id]); if you are done or nothing is needed, chat_ack; if you are blocked, chat_suspend.',
    inRoom: (name) => `in ${name}`,
    inRoomId: (id) => `in room ${id}`,
    messageLeads: {
      mention: { by: (sender, room) => `${sender} mentioned you ${room}`, alone: (room) => `You received a mention ${room}` },
      direct: { by: (sender, room) => `${sender} sent you a direct message ${room}`, alone: (room) => `You received a direct message ${room}` },
      reply: { by: (sender, room) => `${sender} replied to a message of yours ${room}`, alone: (room) => `You received a reply ${room}` },
      edited: { by: (sender, room) => `${sender} edited a message you were told about ${room}; read it again with chat_messages before acting on it`, alone: (room) => `A message you were told about was edited ${room}; read it again with chat_messages before acting on it` },
      deleted: { by: (sender, room) => `${sender} deleted a message you had read ${room}; its text and attachments are gone, so do not act on it anymore`, alone: (room) => `A message you had read was deleted ${room}; its text and attachments are gone, so do not act on it anymore` },
    },
    claimReleased: (room) => `A person released the reply to a message that mentions you ${room}; nobody has claimed it now. If it is still yours, claim it with chat_reply_claim and answer`,
    otherLead: { by: (sender, room) => `${sender} sent a notice ${room}`, alone: (room) => `You received a notice ${room}` },
    messageNumber: (id) => `message ${id}`,
    lockBusy: (handle) => `Another session already receives the notices of @${handle}. This one takes over if that one closes.`,
    lockAcquired: (handle) => `This session now receives the notices of @${handle}.`,
    suspended: {
      delivery_attempts_exhausted: (ids) => `Notices ${ids} were resent up to the limit without confirmation and are suspended. They do not come back on their own: check the history and use chat_retry or chat_ack.`,
      processing_lease_expired: (ids) => `The processing deadline of notices ${ids} expired and they are suspended. They do not come back on their own: check the history and use chat_retry or chat_ack.`,
      interrupted_processing: (ids) => `The previous session stopped in the middle of notices ${ids}, which are suspended. Check the history before using chat_retry or chat_ack.`,
    },
    queueFull: (count, max) => `The queue has ${count} notices and reached POLYROOM_QUEUE_MAX (${max}): polling stopped fetching new notices until it empties. Suspended notices count in the queue; check them with chat_polling_status and use chat_retry or chat_ack.`,
  },
  es: {
    place: (position, total) => ` (${position} de ${total})`,
    debateExpired: (place, clock) => `El plazo de tu turno en el debate${place} venció a las ${clock}. `
      + 'Revisa el debate de este mensaje con chat_messages antes de responder: el turno puede haber pasado ya al siguiente.',
    debateTurn: (place, clock) => `Es tu turno en el debate${place}${clock ? `, hasta las ${clock}` : ''}. `
      + 'Lee la conversación desde este mensaje y respóndelo (replyTo) sin repetir lo que ya se dijo; si no tienes nada que añadir, reacciona a él con chat_react para pasar el turno. '
      + 'Cualquier reacción a él en tu turno pasa el turno, incluso un emoji repetido: si vas a responder, no reacciones.',
    everyone: 'Todos responden: puedes responder directamente, sin reservar la respuesta.',
    debateWait: 'Mensaje en debate: responde solo cuando llegue el aviso de tu turno.',
    cardLeads: {
      card_assigned: { by: (sender, card) => `${sender} te asignó a la tarjeta ${card}`, alone: (card) => `Se te asignó la tarjeta ${card}` },
      card_comment_mention: { by: (sender, card) => `${sender} te mencionó en un comentario de la tarjeta ${card}`, alone: (card) => `Se te mencionó en un comentario de la tarjeta ${card}` },
      card_description_mention: { by: (sender, card) => `${sender} te mencionó en la descripción de la tarjeta ${card}`, alone: (card) => `Se te mencionó en la descripción de la tarjeta ${card}` },
      card_returned: { by: (sender, card) => `${sender} devolvió de la aprobación la tarjeta ${card}`, alone: (card) => `La tarjeta ${card} fue devuelta de la aprobación` },
      card_approved: { by: (sender, card) => `${sender} aprobó la tarjeta ${card}, cuya aprobación solicitaste`, alone: (card) => `La tarjeta ${card}, cuya aprobación solicitaste, fue aprobada` },
    },
    otherCardLead: { by: (sender, card) => `${sender} envió un aviso sobre la tarjeta ${card}`, alone: (card) => `Recibiste un aviso sobre la tarjeta ${card}` },
    decisionLeads: {
      decision_proposed: { by: (sender, room) => `${sender} pidió tu aprobación para una decisión ${room}`, alone: (room) => `Se pidió tu aprobación para una decisión ${room}` },
      decision_reviewed: { by: (sender, room) => `${sender} revisó una decisión en la que participas, ${room}`, alone: (room) => `Se revisó una decisión en la que participas, ${room}` },
      decision_approvers_changed: { by: (sender, room) => `${sender} te incluyó entre los aprobadores de decisiones ${room}, que tiene decisiones esperando aprobación`,
        alone: (room) => `Se te incluyó entre los aprobadores de decisiones ${room}, que tiene decisiones esperando aprobación` },
    },
    otherDecisionLead: { by: (sender, room) => `${sender} envió un aviso sobre una decisión ${room}`, alone: (room) => `Recibiste un aviso sobre una decisión ${room}` },
    pendingLeads: {
      pending_assigned: { by: (sender, room) => `${sender} abrió un pendiente para ti sobre un mensaje ${room}`, alone: (room) => `Se abrió un pendiente para ti sobre un mensaje ${room}` },
    },
    otherPendingLead: { by: (sender, room) => `${sender} envió un aviso sobre un pendiente ${room}`, alone: (room) => `Recibiste un aviso sobre un pendiente ${room}` },
    batchLeads: {
      closed: (room, answered, total) => `Tu solicitud de respuestas ${room} se cerró: ${answered === 0 ? 'ningún agente respondió ni reaccionó'
        : `${answered} de ${total} ${total === 1 ? 'agente' : 'agentes'} ${answered === 1 ? 'respondió o reaccionó' : 'respondieron o reaccionaron'}`}`,
      debate: (room, answered, total) => `Tu debate ${room} terminó: ${answered === 0 ? 'ningún agente habló'
        : `${answered} de ${total} ${total === 1 ? 'agente' : 'agentes'} ${answered === 1 ? 'habló' : 'hablaron'}`}`,
      answered: (names) => `Respuestas y reacciones: ${names}`,
      spoke: (names) => `Intervenciones en el debate: ${names}`,
      stopWaiting: 'No sigas esperando respuestas a esta solicitud cerrada. Aún pueden llegar respuestas posteriores.',
      replied: (name, room) => `${name} respondió a tu solicitud de respuestas ${room} después del cierre`,
      reacted: (name, emoji, room) => `${name} reaccionó con ${emoji} a tu solicitud de respuestas ${room} después del cierre`,
      other: (room) => `Recibiste un aviso sobre una solicitud de respuestas ${room}. Consulta el mensaje de origen y las respuestas posteriores antes de actuar`,
    },
    batchMembers: {
      missed: (name) => `No hubo respuesta ni reacción de ${name} antes del plazo.`,
      undelivered: (name, reason) => `Sin entrega confirmada a ${name} antes del plazo${reason ? ` (código de entrega: ${reason})` : ''}.`,
      removed: (name) => `${name} salió de la sala.`,
      stopped: (name) => `${name} no respondió ni reaccionó antes del cierre.`,
      debate_cancelled: (name) => `${name} no habló antes del cierre del debate.`,
      declined: (name, reason) => `${name} declinó la solicitud de respuesta.${reason ? ` Motivo indicado: ${reason}.` : ''}`,
      passed: (name) => `${name} pasó su turno.`,
    },
    noReference: 'sin referencia',
    resend: (attempt) => `(reenvío ${attempt})`,
    firstAction: 'Antes de actuar, llame a chat_processing (eventIds = [event_id]); al terminar, o si no hace falta nada, chat_ack.',
    resendAction: 'Si todavía está trabajando en este aviso, llame a chat_processing (eventIds = [event_id]); si ya terminó o no hace falta nada, chat_ack; si está bloqueado, chat_suspend.',
    inRoom: (name) => `en ${name}`,
    inRoomId: (id) => `en la sala ${id}`,
    messageLeads: {
      mention: { by: (sender, room) => `${sender} te mencionó ${room}`, alone: (room) => `Recibiste una mención ${room}` },
      direct: { by: (sender, room) => `${sender} te envió un mensaje directo ${room}`, alone: (room) => `Recibiste un mensaje directo ${room}` },
      reply: { by: (sender, room) => `${sender} respondió a un mensaje tuyo ${room}`, alone: (room) => `Recibiste una respuesta ${room}` },
      edited: { by: (sender, room) => `${sender} editó un mensaje del que te avisaron ${room}; vuelve a leerlo con chat_messages antes de actuar`, alone: (room) => `Se editó un mensaje del que te avisaron ${room}; vuelve a leerlo con chat_messages antes de actuar` },
      deleted: { by: (sender, room) => `${sender} eliminó un mensaje que leíste ${room}; el texto y los adjuntos ya no están, así que no actúes más sobre él`, alone: (room) => `Se eliminó un mensaje que leíste ${room}; el texto y los adjuntos ya no están, así que no actúes más sobre él` },
    },
    claimReleased: (room) => `Una persona liberó la respuesta a un mensaje que te menciona ${room}; nadie la ha reservado ahora. Si todavía es tuya, resérvala con chat_reply_claim y responde`,
    otherLead: { by: (sender, room) => `${sender} envió un aviso ${room}`, alone: (room) => `Recibiste un aviso ${room}` },
    messageNumber: (id) => `mensaje ${id}`,
    lockBusy: (handle) => `Otra sesión ya recibe los avisos de @${handle}. Esta toma el relevo si aquella se cierra.`,
    lockAcquired: (handle) => `Esta sesión pasó a recibir los avisos de @${handle}.`,
    suspended: {
      delivery_attempts_exhausted: (ids) => `Los avisos ${ids} se reenviaron hasta el límite sin confirmación y quedaron suspendidos. No vuelven solos: revisa el historial y usa chat_retry o chat_ack.`,
      processing_lease_expired: (ids) => `El plazo de procesamiento de los avisos ${ids} venció y quedaron suspendidos. No vuelven solos: revisa el historial y usa chat_retry o chat_ack.`,
      interrupted_processing: (ids) => `La sesión anterior se detuvo en medio de los avisos ${ids}, que quedaron suspendidos. Revisa el historial antes de usar chat_retry o chat_ack.`,
    },
    queueFull: (count, max) => `La cola tiene ${count} avisos y llegó a POLYROOM_QUEUE_MAX (${max}): el polling dejó de buscar avisos nuevos hasta que se vacíe. Los avisos suspendidos cuentan en la cola; revísalos con chat_polling_status y usa chat_retry o chat_ack.`,
  },
};

export const noticeCatalogs = catalogs;

export function noticeTexts(locale) {
  const catalog = catalogs[noticeLocaleOf(locale) ?? fallbackNoticeLocale];
  return {
    ...catalog,
    suspendedNotice: (rawIds, reason) => Object.hasOwn(catalog.suspended, reason) ? catalog.suspended[reason](rawIds.map((id) => sanitize(id)).join(', ')) : undefined,
  };
}

const attributeValue = (value) => String(value).replaceAll('"', '”').replaceAll('&', '＆');

function clean(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return sanitize(value) || null;
}

function senderName(sender) {
  const handle = clean(sender?.handle);
  return clean(sender?.name) ?? (handle ? `@${handle}` : null);
}

function senderTag(sender) {
  const handle = clean(sender?.handle);
  return handle ? `@${handle}` : clean(sender?.name);
}

function turnOf(event) {
  const turn = event.turn;
  if (turn === null || typeof turn !== 'object' || Array.isArray(turn)) return null;
  return { position: clean(turn.position), total: clean(turn.total), deadline: clean(turn.deadlineAt) };
}

function deadlineOf(deadline, locale) {
  const time = Date.parse(deadline ?? '');
  if (!Number.isFinite(time)) return null;
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: turnTimeZone }).format(time);
  return { time, clock: `${clock} ${turnTimeZone}` };
}

function debateTurnNotice(turn, now, texts, locale) {
  const place = turn.position && turn.total ? texts.place(turn.position, turn.total) : '';
  const deadline = deadlineOf(turn.deadline, locale);
  if (deadline && deadline.time <= now) return texts.debateExpired(place, deadline.clock);
  return texts.debateTurn(place, deadline?.clock ?? null);
}

function replyModeNotice(event, now, texts, locale) {
  const turn = turnOf(event);
  if (event.replyMode === 'debate' && turn) return debateTurnNotice(turn, now, texts, locale);
  if (!answeringReasons.has(event.reason)) return null;
  if (event.replyMode === 'everyone') return texts.everyone;
  if (event.replyMode === 'debate') return texts.debateWait;
  return null;
}

export const isCardNotice = (event) => event?.kind === 'card';

function cardOf(event) {
  const card = event.card !== null && typeof event.card === 'object' && !Array.isArray(event.card) ? event.card : {};
  return { id: clean(card.id), ref: clean(card.ref), boardId: clean(card.boardId) };
}

const plainCardReference = /^(?:[A-Za-z]{2,10}-\d{1,9}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/;

function referenceOf(card, texts) {
  const plain = [card.ref, card.id].find((value) => value && plainCardReference.test(value));
  if (plain) return plain;
  const other = card.ref ?? card.id;
  return other ? JSON.stringify(other) : texts.noReference;
}

const withAttempt = (body, attempt, texts) => attempt > 0 ? `${body} ${texts.resend(attempt)}` : body;

function cardContent(event, attempt, texts) {
  const card = cardOf(event);
  const reference = referenceOf(card, texts);
  const sender = senderTag(event.sender);
  const leads = Object.hasOwn(texts.cardLeads, event.reason) ? texts.cardLeads[event.reason] : texts.otherCardLead;
  const lead = sender ? leads.by(sender, reference) : leads.alone(reference);
  const link = clean(event.link);
  const body = link ? `${lead}: ${link}` : `${lead}.`;
  return withAttempt(body, attempt, texts);
}

function cardNotification(event, attempt, origin, locale) {
  const card = cardOf(event);
  const meta = { event_id: sanitize(event.id), kind: 'card', reason: sanitize(event.reason) };
  if (card.id) meta.card_id = card.id;
  if (card.ref) meta.card_ref = card.ref;
  if (card.boardId) meta.board_id = card.boardId;
  const link = clean(event.link);
  if (link) meta.link = link;
  const sender = senderTag(event.sender);
  if (sender) meta.sender = sender;
  Object.assign(meta, { created_at: sanitize(event.createdAt), attempt: String(attempt), origin });
  const attributes = Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, attributeValue(value)]));
  return { content: cardContent(event, attempt, noticeTexts(locale)), meta: attributes };
}

export const isDecisionNotice = (event) => event?.kind === 'decision';

function decisionIdOf(event) {
  const decision = event.decision !== null && typeof event.decision === 'object' && !Array.isArray(event.decision) ? event.decision : {};
  return clean(decision.id);
}

function decisionContent(event, attempt, texts) {
  const roomName = clean(event.roomName);
  const room = roomName ? texts.inRoom(roomName) : texts.inRoomId(clean(event.roomId));
  const sender = senderTag(event.sender);
  const leads = Object.hasOwn(texts.decisionLeads, event.reason) ? texts.decisionLeads[event.reason] : texts.otherDecisionLead;
  const lead = sender ? leads.by(sender, room) : leads.alone(room);
  const link = clean(event.link);
  return withAttempt(link ? `${lead}: ${link}` : `${lead}.`, attempt, texts);
}

function decisionNotification(event, attempt, origin, locale) {
  const meta = { event_id: sanitize(event.id), kind: 'decision', reason: sanitize(event.reason) };
  const roomId = clean(event.roomId);
  if (roomId) meta.room_id = roomId;
  const decisionId = decisionIdOf(event);
  if (decisionId) meta.decision_id = decisionId;
  const roomName = clean(event.roomName);
  if (roomName) meta.room_name = roomName;
  const link = clean(event.link);
  if (link) meta.link = link;
  const sender = senderTag(event.sender);
  if (sender) meta.sender = sender;
  Object.assign(meta, { created_at: sanitize(event.createdAt), attempt: String(attempt), origin });
  const attributes = Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, attributeValue(value)]));
  return { content: decisionContent(event, attempt, noticeTexts(locale)), meta: attributes };
}

export const isPendingNotice = (event) => event?.kind === 'pending';

function pendingOf(event) {
  const pending = event.pending !== null && typeof event.pending === 'object' && !Array.isArray(event.pending) ? event.pending : {};
  return { id: clean(pending.id), messageId: clean(pending.messageId) };
}

function pendingContent(event, attempt, texts) {
  const roomName = clean(event.roomName);
  const room = roomName ? texts.inRoom(roomName) : texts.inRoomId(clean(event.roomId));
  const sender = senderTag(event.sender);
  const leads = Object.hasOwn(texts.pendingLeads, event.reason) ? texts.pendingLeads[event.reason] : texts.otherPendingLead;
  const lead = sender ? leads.by(sender, room) : leads.alone(room);
  const link = clean(event.link);
  return withAttempt(link ? `${lead}: ${link}` : `${lead}.`, attempt, texts);
}

function pendingNotification(event, attempt, origin, locale) {
  const meta = { event_id: sanitize(event.id), kind: 'pending', reason: sanitize(event.reason) };
  const roomId = clean(event.roomId);
  if (roomId) meta.room_id = roomId;
  const pending = pendingOf(event);
  if (pending.messageId) meta.message_id = pending.messageId;
  if (pending.id) meta.pending_id = pending.id;
  const roomName = clean(event.roomName);
  if (roomName) meta.room_name = roomName;
  const link = clean(event.link);
  if (link) meta.link = link;
  const sender = senderTag(event.sender);
  if (sender) meta.sender = sender;
  Object.assign(meta, { created_at: sanitize(event.createdAt), attempt: String(attempt), origin });
  const attributes = Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, attributeValue(value)]));
  return { content: pendingContent(event, attempt, noticeTexts(locale)), meta: attributes };
}

export const isReplyBatchNotice = (event) => event?.kind === 'reply_batch';

const objectOf = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const listOf = (value) => Array.isArray(value) ? value.map(objectOf).filter(Boolean) : [];

function batchOf(event) {
  const batch = objectOf(event.batch);
  if (!batch) return null;
  return { state: clean(batch.state), event: clean(batch.event), total: clean(batch.total), answers: listOf(batch.answers), missing: listOf(batch.missing), member: objectOf(batch.member) };
}

function replyBatchContent(event, attempt, texts) {
  const roomName = clean(event.roomName);
  const room = roomName ? texts.inRoom(roomName) : texts.inRoomId(clean(event.roomId));
  const batch = batchOf(event);
  const leads = texts.batchLeads;
  const sentences = [];
  if (batch?.event === 'member_updated' && batch.member) {
    const name = senderTag(batch.member.agent) ?? texts.noReference;
    const emoji = clean(batch.member.reactionEmoji);
    sentences.push(`${emoji ? leads.reacted(name, emoji, room) : leads.replied(name, room)}.`);
  } else if (batch?.event === 'closed') {
    const debate = batch.state === 'debate_finished';
    const total = Number(batch.total ?? batch.answers.length + batch.missing.length);
    sentences.push(`${(debate ? leads.debate : leads.closed)(room, batch.answers.length, total)}.`);
    const names = batch.answers.map((item) => {
      const name = senderTag(item.agent);
      const emoji = clean(item.reactionEmoji);
      return name && emoji ? `${name} (${emoji})` : name;
    }).filter(Boolean);
    if (names.length) sentences.push(`${(debate ? leads.spoke : leads.answered)(names.join(', '))}.`);
    for (const item of batch.missing) {
      const name = senderTag(item.agent);
      const state = clean(item.state);
      const said = debate && state === 'declined' ? 'passed' : state === 'passed' ? null : state;
      if (name && said && Object.hasOwn(texts.batchMembers, said)) sentences.push(texts.batchMembers[said](name, clean(item.reason)));
    }
    if (!debate && batch.missing.length) sentences.push(leads.stopWaiting);
  } else sentences.push(`${leads.other(room)}.`);
  const link = clean(event.link);
  return withAttempt(link ? `${sentences.join(' ')} ${link}` : sentences.join(' '), attempt, texts);
}

function replyBatchNotification(event, attempt, origin, locale) {
  const meta = { event_id: sanitize(event.id), kind: 'reply_batch', reason: sanitize(event.reason) };
  const roomId = clean(event.roomId);
  if (roomId) meta.room_id = roomId;
  const messageId = clean(event.messageId);
  if (messageId) meta.message_id = messageId;
  const roomName = clean(event.roomName);
  if (roomName) meta.room_name = roomName;
  const link = clean(event.link);
  if (link) meta.link = link;
  const batch = batchOf(event);
  if (batch?.state) meta.batch_state = batch.state;
  if (batch?.event) meta.batch_event = batch.event;
  if (batch?.total) meta.total = batch.total;
  if (batch) Object.assign(meta, { answered: String(batch.answers.length), missing: String(batch.missing.length) });
  Object.assign(meta, { created_at: sanitize(event.createdAt), attempt: String(attempt), origin });
  const attributes = Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, attributeValue(value)]));
  return { content: replyBatchContent(event, attempt, noticeTexts(locale)), meta: attributes };
}

export function eventContent(event, attempt = 0, now = systemClock.now(), locale = fallbackNoticeLocale) {
  const texts = noticeTexts(locale);
  if (isCardNotice(event)) return cardContent(event, attempt, texts);
  if (isDecisionNotice(event)) return decisionContent(event, attempt, texts);
  if (isPendingNotice(event)) return pendingContent(event, attempt, texts);
  if (isReplyBatchNotice(event)) return replyBatchContent(event, attempt, texts);
  const sender = senderName(event.sender);
  const roomName = clean(event.roomName);
  const room = roomName ? texts.inRoom(roomName) : texts.inRoomId(clean(event.roomId));
  let lead;
  if (event.reason === 'claim_released') lead = texts.claimReleased(room);
  else {
    const leads = Object.hasOwn(texts.messageLeads, event.reason) ? texts.messageLeads[event.reason] : texts.otherLead;
    lead = sender ? leads.by(sender, room) : leads.alone(room);
  }
  const excerpt = clean(event.excerpt);
  const head = excerpt ? `${lead}: ${JSON.stringify(excerpt)}` : `${lead}, ${texts.messageNumber(clean(event.messageId))}`;
  const notice = replyModeNotice(event, now, texts, noticeLocaleOf(locale) ?? fallbackNoticeLocale);
  const body = notice ? `${head}. ${notice}` : excerpt ? head : `${head}.`;
  return withAttempt(body, attempt, texts);
}

export function eventNotification(event, { attempt = 0, origin = 'live', now = systemClock.now(), locale = fallbackNoticeLocale } = {}) {
  if (isCardNotice(event)) return cardNotification(event, attempt, origin, locale);
  if (isDecisionNotice(event)) return decisionNotification(event, attempt, origin, locale);
  if (isPendingNotice(event)) return pendingNotification(event, attempt, origin, locale);
  if (isReplyBatchNotice(event)) return replyBatchNotification(event, attempt, origin, locale);
  const meta = {
    event_id: sanitize(event.id),
    room_id: sanitize(event.roomId),
    message_id: sanitize(event.messageId),
    reason: sanitize(event.reason),
    created_at: sanitize(event.createdAt),
    attempt: String(attempt),
    origin,
  };
  const roomName = clean(event.roomName);
  if (roomName) meta.room_name = roomName;
  const sender = senderTag(event.sender);
  if (sender) meta.sender = sender;
  const replyMode = clean(event.replyMode);
  if (replyMode) meta.reply_mode = replyMode;
  if (Number.isSafeInteger(event.replyTo) && event.replyTo > 0) meta.reply_to = String(event.replyTo);
  const turn = turnOf(event);
  if (turn?.position) meta.turn_position = turn.position;
  if (turn?.total) meta.turn_total = turn.total;
  if (turn?.deadline) meta.turn_deadline = turn.deadline;
  const attributes = Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, attributeValue(value)]));
  return { content: eventContent(event, attempt, now, locale), meta: attributes };
}

export function statusNotification(state, content) {
  return { content, meta: { reason: 'status', state } };
}

