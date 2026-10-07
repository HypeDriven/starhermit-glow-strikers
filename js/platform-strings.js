// Localized strings for the StarHermit account surface (sign-in, invite link,
// room invites, controls reset, sign-out notice). Locale picked from
// navigator.language like the Graphics section (js/gfx-strings.js).
import { pickLocale } from './gfx-strings.js';

const EN = {
  signIn: 'Sign in with StarHermit', invite: 'Invite a friend',
  inviteCopied: 'Invite link copied to clipboard', inviteFailed: 'Could not copy the invite link',
  signedOut: 'Signed out of StarHermit — progress keeps saving on this device',
  inviteFriends: 'Invite friends to this room', inviteBtn: 'Invite', invited: 'Invited',
  online: 'online', offline: 'offline', noFriends: 'No friends to invite yet.',
  roomInvites: 'Room invites', inviteFrom: '{name} invited you', accept: 'Accept', decline: 'Decline',
  resetKeys: 'Reset controls',
  sessionExpired: 'Your session expired', sessionExpiredBody: 'Your StarHermit session ended, so the room connection stopped. Go back to StarHermit to start a fresh session.',
  relaunch: 'Back to StarHermit', playLocal: 'Play on this device',
};

const STRINGS = {
  'en-US': EN,
  'en-GB': EN,
  'es-419': {
    signIn: 'Iniciar sesión con StarHermit', invite: 'Invitar a un amigo',
    inviteCopied: 'Enlace de invitación copiado', inviteFailed: 'No se pudo copiar el enlace de invitación',
    signedOut: 'Se cerró la sesión de StarHermit; el progreso se sigue guardando en este dispositivo',
    inviteFriends: 'Invita amigos a esta sala', inviteBtn: 'Invitar', invited: 'Invitado',
    online: 'en línea', offline: 'desconectado', noFriends: 'Aún no tienes amigos para invitar.',
    roomInvites: 'Invitaciones a salas', inviteFrom: '{name} te invitó', accept: 'Aceptar', decline: 'Rechazar',
    resetKeys: 'Restablecer controles',
    sessionExpired: 'Tu sesión expiró', sessionExpiredBody: 'Tu sesión de StarHermit terminó y se detuvo la conexión con la sala. Vuelve a StarHermit para iniciar una nueva sesión.',
    relaunch: 'Volver a StarHermit', playLocal: 'Jugar en este dispositivo',
  },
  'es-ES': {
    signIn: 'Iniciar sesión con StarHermit', invite: 'Invitar a un amigo',
    inviteCopied: 'Enlace de invitación copiado', inviteFailed: 'No se ha podido copiar el enlace de invitación',
    signedOut: 'Se ha cerrado la sesión de StarHermit; el progreso se sigue guardando en este dispositivo',
    inviteFriends: 'Invita a amigos a esta sala', inviteBtn: 'Invitar', invited: 'Invitado',
    online: 'conectado', offline: 'desconectado', noFriends: 'Todavía no tienes amigos a los que invitar.',
    roomInvites: 'Invitaciones a salas', inviteFrom: '{name} te ha invitado', accept: 'Aceptar', decline: 'Rechazar',
    resetKeys: 'Restablecer controles',
    sessionExpired: 'Tu sesión ha caducado', sessionExpiredBody: 'Tu sesión de StarHermit ha terminado y se ha detenido la conexión con la sala. Vuelve a StarHermit para iniciar una nueva sesión.',
    relaunch: 'Volver a StarHermit', playLocal: 'Jugar en este dispositivo',
  },
  'de-DE': {
    signIn: 'Mit StarHermit anmelden', invite: 'Freund einladen',
    inviteCopied: 'Einladungslink kopiert', inviteFailed: 'Einladungslink konnte nicht kopiert werden',
    signedOut: 'Von StarHermit abgemeldet – der Fortschritt wird weiter auf diesem Gerät gespeichert',
    inviteFriends: 'Freunde in diesen Raum einladen', inviteBtn: 'Einladen', invited: 'Eingeladen',
    online: 'online', offline: 'offline', noFriends: 'Noch keine Freunde zum Einladen.',
    roomInvites: 'Raumeinladungen', inviteFrom: '{name} hat dich eingeladen', accept: 'Annehmen', decline: 'Ablehnen',
    resetKeys: 'Steuerung zurücksetzen',
    sessionExpired: 'Deine Sitzung ist abgelaufen', sessionExpiredBody: 'Deine StarHermit-Sitzung ist beendet, daher wurde die Raumverbindung getrennt. Kehre zu StarHermit zurück, um eine neue Sitzung zu starten.',
    relaunch: 'Zurück zu StarHermit', playLocal: 'Auf diesem Gerät spielen',
  },
  'fr-FR': {
    signIn: 'Se connecter avec StarHermit', invite: 'Inviter un ami',
    inviteCopied: 'Lien d’invitation copié', inviteFailed: 'Impossible de copier le lien d’invitation',
    signedOut: 'Déconnecté de StarHermit : la progression reste enregistrée sur cet appareil',
    inviteFriends: 'Inviter des amis dans ce salon', inviteBtn: 'Inviter', invited: 'Invité',
    online: 'en ligne', offline: 'hors ligne', noFriends: 'Aucun ami à inviter pour l’instant.',
    roomInvites: 'Invitations aux salons', inviteFrom: '{name} t’a invité', accept: 'Accepter', decline: 'Refuser',
    resetKeys: 'Réinitialiser les commandes',
    sessionExpired: 'Ta session a expiré', sessionExpiredBody: 'Ta session StarHermit est terminée, la connexion au salon a donc été interrompue. Retourne sur StarHermit pour démarrer une nouvelle session.',
    relaunch: 'Retour à StarHermit', playLocal: 'Jouer sur cet appareil',
  },
  'fr-CA': {
    signIn: 'Se connecter avec StarHermit', invite: 'Inviter un ami',
    inviteCopied: 'Lien d’invitation copié', inviteFailed: 'Impossible de copier le lien d’invitation',
    signedOut: 'Déconnecté de StarHermit : la progression reste enregistrée sur cet appareil',
    inviteFriends: 'Inviter des amis dans cette salle', inviteBtn: 'Inviter', invited: 'Invité',
    online: 'en ligne', offline: 'hors ligne', noFriends: 'Aucun ami à inviter pour l’instant.',
    roomInvites: 'Invitations aux salles', inviteFrom: '{name} t’a invité', accept: 'Accepter', decline: 'Refuser',
    resetKeys: 'Réinitialiser les commandes',
    sessionExpired: 'Ta session a expiré', sessionExpiredBody: 'Ta session StarHermit est terminée, la connexion à la salle a donc été interrompue. Retourne sur StarHermit pour démarrer une nouvelle session.',
    relaunch: 'Retour à StarHermit', playLocal: 'Jouer sur cet appareil',
  },
  'pt-BR': {
    signIn: 'Entrar com StarHermit', invite: 'Convidar um amigo',
    inviteCopied: 'Link de convite copiado', inviteFailed: 'Não foi possível copiar o link de convite',
    signedOut: 'Você saiu do StarHermit — o progresso continua salvo neste dispositivo',
    inviteFriends: 'Convide amigos para esta sala', inviteBtn: 'Convidar', invited: 'Convidado',
    online: 'online', offline: 'offline', noFriends: 'Nenhum amigo para convidar ainda.',
    roomInvites: 'Convites de sala', inviteFrom: '{name} convidou você', accept: 'Aceitar', decline: 'Recusar',
    resetKeys: 'Redefinir controles',
    sessionExpired: 'Sua sessão expirou', sessionExpiredBody: 'Sua sessão do StarHermit terminou e a conexão com a sala foi interrompida. Volte ao StarHermit para iniciar uma nova sessão.',
    relaunch: 'Voltar ao StarHermit', playLocal: 'Jogar neste dispositivo',
  },
  'it-IT': {
    signIn: 'Accedi con StarHermit', invite: 'Invita un amico',
    inviteCopied: 'Link d’invito copiato', inviteFailed: 'Impossibile copiare il link d’invito',
    signedOut: 'Disconnesso da StarHermit: i progressi restano salvati su questo dispositivo',
    inviteFriends: 'Invita amici in questa stanza', inviteBtn: 'Invita', invited: 'Invitato',
    online: 'online', offline: 'offline', noFriends: 'Ancora nessun amico da invitare.',
    roomInvites: 'Inviti alle stanze', inviteFrom: '{name} ti ha invitato', accept: 'Accetta', decline: 'Rifiuta',
    resetKeys: 'Ripristina comandi',
    sessionExpired: 'La tua sessione è scaduta', sessionExpiredBody: 'La tua sessione StarHermit è terminata, quindi la connessione alla stanza si è interrotta. Torna su StarHermit per avviare una nuova sessione.',
    relaunch: 'Torna a StarHermit', playLocal: 'Gioca su questo dispositivo',
  },
};

export const PLATFORM_LOCALES = Object.keys(STRINGS);

/** Strings for the browser's locale (en-US fallback per key). */
export function platformStrings(tag = (typeof navigator !== 'undefined' ? navigator.language : 'en-US')) {
  return { ...EN, ...(STRINGS[pickLocale(tag)] ?? {}) };
}
