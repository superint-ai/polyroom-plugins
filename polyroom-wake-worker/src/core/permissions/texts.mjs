import { fallbackNoticeLocale, noticeLocaleOf } from '../../notices.mjs';

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

export function fenced(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

const catalogs = {
  'pt-BR': {
    relay: ({ bot, tool, description, preview, requestId, timeoutMs }) => `**Pedido de permissão de @${bot}** (código \`${requestId}\`)\n`
      + `Ferramenta: \`${tool}\`\nO que faz: ${description}\n${fenced(preview)}\n`
      + `Responda a esta mensagem só com “pode” (ou “sim”) para liberar, ou “não” para negar. Vale a primeira resposta de um aprovador. `
      + `Sem resposta em ${minutes(timeoutMs)} min, o pedido fica só no terminal.`,
    blocked: ({ bot, tool, reason, command, folder, timeoutMs }) => `**O modo automático bloqueou uma ação de @${bot}**\n`
      + `Relatado pelo próprio agente pelo hook PermissionDenied: o canal não tem como conferir isso no Claude Code. Decida pelo comando abaixo.\nPasta: \`${folder}\`\n`
      + `Ferramenta: \`${tool}\`\nMotivo: ${reason}\n${fenced(command)}\n`
      + `Responda a esta mensagem só com “pode” (ou “sim”) para liberar este comando exato uma vez, ou “não” para negar. Vale a primeira resposta de um aprovador. `
      + `Sem resposta em ${minutes(timeoutMs)} min, o bloqueio fica como está.`,
    terminalOnly: ({ bot, tool, reason, preview, why, folder }) => `**O modo automático bloqueou uma ação de @${bot}**\n`
      + `Relatado pelo próprio agente pelo hook PermissionDenied: o canal não tem como conferir isso no Claude Code. Decida pelo comando abaixo.\nPasta: \`${folder}\`\n`
      + `Ferramenta: \`${tool}\`\nMotivo: ${reason}\n${fenced(preview)}\n`
      + `Esta ação só pode ser liberada no terminal (/permissions → Recently blocked): ${{
        wildcard: 'o comando tem `*`, e uma regra com ele liberaria mais do que este comando',
        multiline: 'o comando tem mais de uma linha, e não cabe numa regra exata',
        compound: 'o comando junta outros comandos (`&&`, `;`, `|`, `&` ou substituição), e o Claude Code confere cada parte, então uma regra exata não o libera',
        empty: 'o comando veio vazio',
        tool: 'só comandos de shell (Bash) têm regra que libera uma ação exata',
        too_long: 'o comando é maior do que a sala mostra, e ninguém deve liberar um trecho que não viu',
      }[why]}.`,
    noReason: 'não informado',
    cardMention: (names) => names.join(' '),
    cardReply: (code) => `Responda com um comentário só com “pode ${code}” ou “não ${code}”, sem mencionar o bot.`,
    failed: ({ requestId }) => `Pedido \`${requestId}\`: aprovado, mas o canal não conseguiu registrar a regra antes de gravá-la. Nada foi liberado; a ação fica no terminal.`,
    resolved: ({ requestId, behavior, approver }) => `Pedido \`${requestId}\`: ${behavior === 'allow' ? 'liberado' : 'negado'} por ${approver}.`,
    expired: ({ requestId }) => `Pedido \`${requestId}\`: venceu sem resposta e ficou no terminal.`,
  },
  'en-US': {
    relay: ({ bot, tool, description, preview, requestId, timeoutMs }) => `**Permission request from @${bot}** (code \`${requestId}\`)\n`
      + `Tool: \`${tool}\`\nWhat it does: ${description}\n${fenced(preview)}\n`
      + `Reply to this message with just “yes” to allow it, or “no” to deny it. The first answer from an approver counts. `
      + `Without an answer in ${minutes(timeoutMs)} min, the request stays in the terminal only.`,
    blocked: ({ bot, tool, reason, command, folder, timeoutMs }) => `**Auto mode blocked an action of @${bot}**\n`
      + `Reported by the agent itself through the PermissionDenied hook: the channel cannot check this in Claude Code. Decide by the command below.\nFolder: \`${folder}\`\n`
      + `Tool: \`${tool}\`\nReason: ${reason}\n${fenced(command)}\n`
      + `Reply to this message with just “yes” to allow this exact command once, or “no” to deny it. The first answer from an approver counts. `
      + `Without an answer in ${minutes(timeoutMs)} min, the block stays.`,
    terminalOnly: ({ bot, tool, reason, preview, why, folder }) => `**Auto mode blocked an action of @${bot}**\n`
      + `Reported by the agent itself through the PermissionDenied hook: the channel cannot check this in Claude Code. Decide by the command below.\nFolder: \`${folder}\`\n`
      + `Tool: \`${tool}\`\nReason: ${reason}\n${fenced(preview)}\n`
      + `Only the terminal can allow this action (/permissions → Recently blocked): ${{
        wildcard: 'the command has a `*`, and a rule with it would allow more than this command',
        multiline: 'the command has more than one line and does not fit an exact rule',
        compound: 'the command chains other commands (`&&`, `;`, `|`, `&` or substitution), and Claude Code checks each part, so an exact rule does not allow it',
        empty: 'the command came empty',
        tool: 'only shell commands (Bash) have a rule that allows one exact action',
        too_long: 'the command is longer than the room shows, and nobody should allow a part they did not see',
      }[why]}.`,
    noReason: 'not given',
    cardMention: (names) => names.join(' '),
    cardReply: (code) => `Answer with a comment that says just “yes ${code}” or “no ${code}”, without mentioning the bot.`,
    failed: ({ requestId }) => `Request \`${requestId}\`: approved, but the channel could not record the rule before writing it. Nothing was allowed; the action stays in the terminal.`,
    resolved: ({ requestId, behavior, approver }) => `Request \`${requestId}\`: ${behavior === 'allow' ? 'allowed' : 'denied'} by ${approver}.`,
    expired: ({ requestId }) => `Request \`${requestId}\`: expired without an answer and stayed in the terminal.`,
  },
  es: {
    relay: ({ bot, tool, description, preview, requestId, timeoutMs }) => `**Solicitud de permiso de @${bot}** (código \`${requestId}\`)\n`
      + `Herramienta: \`${tool}\`\nQué hace: ${description}\n${fenced(preview)}\n`
      + `Responde a este mensaje solo con “sí” para permitirlo, o “no” para negarlo. Vale la primera respuesta de un aprobador. `
      + `Sin respuesta en ${minutes(timeoutMs)} min, la solicitud queda solo en la terminal.`,
    blocked: ({ bot, tool, reason, command, folder, timeoutMs }) => `**El modo automático bloqueó una acción de @${bot}**\n`
      + `Informado por el propio agente con el hook PermissionDenied: el canal no puede comprobarlo en Claude Code. Decide por el comando de abajo.\nCarpeta: \`${folder}\`\n`
      + `Herramienta: \`${tool}\`\nMotivo: ${reason}\n${fenced(command)}\n`
      + `Responde a este mensaje solo con “sí” para permitir este comando exacto una vez, o “no” para negarlo. Vale la primera respuesta de un aprobador. `
      + `Sin respuesta en ${minutes(timeoutMs)} min, el bloqueo se mantiene.`,
    terminalOnly: ({ bot, tool, reason, preview, why, folder }) => `**El modo automático bloqueó una acción de @${bot}**\n`
      + `Informado por el propio agente con el hook PermissionDenied: el canal no puede comprobarlo en Claude Code. Decide por el comando de abajo.\nCarpeta: \`${folder}\`\n`
      + `Herramienta: \`${tool}\`\nMotivo: ${reason}\n${fenced(preview)}\n`
      + `Solo la terminal puede permitir esta acción (/permissions → Recently blocked): ${{
        wildcard: 'el comando tiene `*`, y una regla con él permitiría más que este comando',
        multiline: 'el comando tiene más de una línea y no cabe en una regla exacta',
        compound: 'el comando encadena otros comandos (`&&`, `;`, `|`, `&` o sustitución), y Claude Code revisa cada parte, así que una regla exacta no lo permite',
        empty: 'el comando llegó vacío',
        tool: 'solo los comandos de shell (Bash) tienen una regla que permite una acción exacta',
        too_long: 'el comando es más largo de lo que la sala muestra, y nadie debe permitir una parte que no vio',
      }[why]}.`,
    noReason: 'no informado',
    cardMention: (names) => names.join(' '),
    cardReply: (code) => `Responde con un comentario que diga solo “sí ${code}” o “no ${code}”, sin mencionar al bot.`,
    failed: ({ requestId }) => `Solicitud \`${requestId}\`: aprobada, pero el canal no pudo registrar la regla antes de grabarla. No se permitió nada; la acción queda en la terminal.`,
    resolved: ({ requestId, behavior, approver }) => `Solicitud \`${requestId}\`: ${behavior === 'allow' ? 'permitida' : 'negada'} por ${approver}.`,
    expired: ({ requestId }) => `Solicitud \`${requestId}\`: venció sin respuesta y quedó en la terminal.`,
  },
};

export const permissionCatalogs = catalogs;
export const permissionTexts = (locale) => catalogs[noticeLocaleOf(locale) ?? fallbackNoticeLocale];

export const wakeTexts = {
  approved: ({ approver, roomId, command }) => `polyroom permission: ${approver.name} (id ${approver.id}) approved in room ${roomId} the action that auto mode blocked, this exact command:\n${fenced(command)}\n`
    + 'A permission rule now allows that exact command once. Run it again exactly as written, once; any other command goes through the normal checks.',
  denied: ({ approver, roomId, command }) => `polyroom permission: ${approver.name} (id ${approver.id}) denied in room ${roomId} the action that auto mode blocked:\n${fenced(command)}\nDo not retry it.`,
};
