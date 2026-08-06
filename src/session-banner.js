'use strict';

const oneLine = (value) => String(value || '').replace(/\s+/g, ' ').trim();

/** A terminal-safe stand-in for the buddy art, chosen to remain recognizable. */
function avatarForCharacter(character = '', label = '') {
  const name = `${character} ${label}`.toLowerCase();
  if (name.includes('fox')) return '🦊';
  if (/cat|miso|crumb/.test(name)) return '🐈';
  if (name.includes('orbit')) return '🪐';
  if (name.includes('azure')) return '🔵';
  if (name.includes('clod')) return '🟧';
  return '📎';
}

/**
 * A hook system message appears at the top of both Claude Code and Codex
 * sessions. Their terminal UIs cannot embed our sprite, so an emoji avatar +
 * exact character name makes the dynamic per-session assignment visible.
 */
function sessionBanner({ character = '', label = 'Clippy', project = '', agent = '', model = '' } = {}) {
  const buddy = oneLine(label) || 'Clippy';
  const runtime = [oneLine(agent), oneLine(model)].filter(Boolean).join(' · ');
  return [
    `${avatarForCharacter(character, buddy)} Connected to ${buddy}`,
    project ? `look for ${buddy} watching “${oneLine(project)}”` : `look for ${buddy}`,
    runtime,
  ].filter(Boolean).join(' — ');
}

function sessionBannerOutput(details) {
  return { systemMessage: sessionBanner(details) };
}

module.exports = { avatarForCharacter, sessionBanner, sessionBannerOutput };
