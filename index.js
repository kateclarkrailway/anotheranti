const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  REST, Routes, SlashCommandBuilder, AuditLogEvent,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const config = {
  TOKEN: process.env.TOKEN,
  CLIENT_ID: '1508976918140026930',

  QUAR_ROLE_ID:   '1508968420933370017',  // role applied on quarantine
  IMMUNE_ROLE_ID: '1506430627501703249',  // staff / trusted role
  LOG_CHANNEL_ID: '1508973950573613146',  // antinuke log channel

  // Ping flood
  PING_LIMIT:    10,
  PING_WINDOW_MS: 25000,

  // Mass-action thresholds (bans / kicks in window)
  MASS_BAN_LIMIT:    3,
  MASS_KICK_LIMIT:   3,
  MASS_WINDOW_MS: 10000,

  // Channel / role action thresholds
  CHANNEL_ACTION_LIMIT: 2,   // creates OR deletes in window
  ROLE_ACTION_LIMIT:    2,
  ACTION_WINDOW_MS:  8000,

  // Dangerous permissions that trigger role-update detection
  DANGEROUS_PERMS: [
    'Administrator',
    'BanMembers',
    'KickMembers',
    'ManageGuild',
    'ManageRoles',
    'ManageChannels',
    'ManageWebhooks',
  ],
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const pingTracker    = new Map(); // userId → { count, firstPingAt }
const banTracker     = new Map(); // userId → { count, firstAt }
const kickTracker    = new Map(); // userId → { count, firstAt }
const channelTracker = new Map(); // userId → { count, firstAt }
const roleTracker    = new Map(); // userId → { count, firstAt }

const whitelist  = new Set();            // userId → immune from all checks
const savedRoles = new Map();            // userId → string[] of role IDs

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function isImmune(member) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (whitelist.has(member.id)) return true;
  if (member.roles.cache.has(config.IMMUNE_ROLE_ID)) return true;
  return false;
}

/**
 * Fetch the executor from audit logs with up to 3 retries.
 * @param {Guild} guild
 * @param {AuditLogEvent} type
 * @param {string} targetId  — ID of the entity affected
 */
async function getExecutor(guild, type, targetId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise(r => setTimeout(r, 800 + attempt * 600));
    const logs = await guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
    if (!logs) continue;
    const entry = logs.entries.find(e => e.target?.id === targetId);
    if (entry) {
      return guild.members.fetch(entry.executor.id).catch(() => null);
    }
  }
  return null;
}

/**
 * Generic rate-tracker. Returns true if the limit is exceeded.
 */
function trackAction(map, userId, limit, windowMs) {
  const now = Date.now();
  const rec = map.get(userId) || { count: 0, firstAt: now };
  if (now - rec.firstAt > windowMs) {
    rec.count = 0;
    rec.firstAt = now;
  }
  rec.count += 1;
  map.set(userId, rec);
  return rec.count >= limit;
}

async function quarantine(member, reason, guild) {
  if (!member) return;
  try {
    const quarRole = guild.roles.cache.get(config.QUAR_ROLE_ID);
    if (!quarRole) return console.error('[ANTINUKE] Quar role not found!');

    // Save current roles (minus @everyone)
    const currentRoles = member.roles.cache.filter(r => r.id !== guild.id);
    savedRoles.set(member.id, currentRoles.map(r => r.id));

    await member.roles.set([quarRole], `Antinuke: ${reason}`);
    await sendLog(guild, member, reason, 0xFF3333, '🔒 User Quarantined');
  } catch (err) {
    console.error('[ANTINUKE] Failed to quarantine:', err.message);
  }
}

async function sendLog(guild, member, reason, color, title, extra = []) {
  const logChannel = guild.channels.cache.get(config.LOG_CHANNEL_ID);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle(`🛡️ Antinuke — ${title}`)
    .setColor(color)
    .addFields(
      { name: 'User',   value: `${member.user.tag} (<@${member.id}>)`, inline: true },
      { name: 'ID',     value: member.id, inline: true },
      { name: 'Reason', value: reason },
      ...extra,
    )
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();

  await logChannel.send({ embeds: [embed] }).catch(console.error);
}

// ─── MESSAGE CREATE — Ping flood + invite links ────────────────────────────
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const member = message.member
    || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  // 1 ── Ping flood
  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  if (mentionCount > 0) {
    const now = Date.now();
    const tracker = pingTracker.get(member.id) || { count: 0, firstPingAt: now };

    if (now - tracker.firstPingAt > config.PING_WINDOW_MS) {
      tracker.count = 0;
      tracker.firstPingAt = now;
    }

    tracker.count += mentionCount;
    pingTracker.set(member.id, tracker);

    if (tracker.count >= config.PING_LIMIT && !isImmune(member)) {
      pingTracker.delete(member.id);
      await message.delete().catch(() => {});
      await quarantine(member,
        `Ping flood — ${tracker.count} pings within 25 seconds`, message.guild);
      return;
    }
  }

  // 2 ── Discord invite links
  const inviteRegex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-zA-Z0-9\-_]+/i;
  if (inviteRegex.test(message.content) && !isImmune(member)) {
    await message.delete().catch(() => {});
    await quarantine(member, 'Sent a Discord invite link without permission', message.guild);
  }
});

// ─── GUILD BAN ADD — mass ban detection ───────────────────────────────────
client.on('guildBanAdd', async (ban) => {
  const guild = ban.guild;
  const executor = await getExecutor(guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  if (!executor || isImmune(executor)) return;

  const exceeded = trackAction(banTracker, executor.id, config.MASS_BAN_LIMIT, config.MASS_WINDOW_MS);
  if (exceeded) {
    banTracker.delete(executor.id);
    await quarantine(executor,
      `Mass ban detected — banned ${config.MASS_BAN_LIMIT}+ members rapidly`, guild);
  }
});

// ─── GUILD MEMBER REMOVE — mass kick detection ────────────────────────────
client.on('guildMemberRemove', async (member) => {
  if (member.user.bot) return;
  const guild = member.guild;
  const executor = await getExecutor(guild, AuditLogEvent.MemberKick, member.id);
  if (!executor || executor.id === member.id || isImmune(executor)) return;

  const exceeded = trackAction(kickTracker, executor.id, config.MASS_KICK_LIMIT, config.MASS_WINDOW_MS);
  if (exceeded) {
    kickTracker.delete(executor.id);
    await quarantine(executor,
      `Mass kick detected — kicked ${config.MASS_KICK_LIMIT}+ members rapidly`, guild);
  }
});

// ─── GUILD MEMBER ADD — bot invite detection ──────────────────────────────
client.on('guildMemberAdd', async (member) => {
  if (!member.user.bot) return;
  const guild = member.guild;
  const executor = await getExecutor(guild, AuditLogEvent.BotAdd, member.id);
  if (!executor || isImmune(executor)) return;

  await quarantine(executor,
    `Added bot ${member.user.tag} (${member.id}) without authorization`, guild);
});

// ─── CHANNEL CREATE — block unauthorized channel creation ─────────────────
client.on('channelCreate', async (channel) => {
  const guild = channel.guild;
  if (!guild) return;

  const executor = await getExecutor(guild, AuditLogEvent.ChannelCreate, channel.id);
  if (!executor || isImmune(executor)) return;

  const exceeded = trackAction(channelTracker, executor.id, config.CHANNEL_ACTION_LIMIT, config.ACTION_WINDOW_MS);
  if (exceeded) {
    channelTracker.delete(executor.id);
    await quarantine(executor,
      `Mass channel creation — created ${config.CHANNEL_ACTION_LIMIT}+ channels rapidly`, guild);
    return;
  }

  // Even a single unauthorized channel create is suspicious — quarantine immediately
  channelTracker.delete(executor.id);
  await quarantine(executor,
    `Created channel "${channel.name}" without authorization`, guild);

  // Try to delete the created channel
  await channel.delete('Antinuke: unauthorized channel creation').catch(() => {});
});

// ─── CHANNEL DELETE — block unauthorized channel deletion ─────────────────
client.on('channelDelete', async (channel) => {
  const guild = channel.guild;
  if (!guild) return;

  const executor = await getExecutor(guild, AuditLogEvent.ChannelDelete, channel.id);
  if (!executor || isImmune(executor)) return;

  const exceeded = trackAction(channelTracker, executor.id, config.CHANNEL_ACTION_LIMIT, config.ACTION_WINDOW_MS);
  if (exceeded) {
    channelTracker.delete(executor.id);
    await quarantine(executor,
      `Mass channel deletion — deleted ${config.CHANNEL_ACTION_LIMIT}+ channels rapidly`, guild);
    return;
  }

  channelTracker.delete(executor.id);
  await quarantine(executor,
    `Deleted channel "${channel.name}" without authorization`, guild);
});

// ─── CHANNEL UPDATE — block dangerous permission overwrites ───────────────
client.on('channelUpdate', async (oldChannel, newChannel) => {
  const guild = newChannel.guild;
  if (!guild) return;

  const executor = await getExecutor(guild, AuditLogEvent.ChannelOverwriteCreate, newChannel.id);
  if (!executor || isImmune(executor)) return;

  // Check if admin-level perms were granted to @everyone or a role
  const newPerms = newChannel.permissionOverwrites?.cache;
  if (!newPerms) return;

  const dangerousGrant = newPerms.some(overwrite =>
    overwrite.allow.has('Administrator') ||
    overwrite.allow.has('ManageChannels') ||
    overwrite.allow.has('ManageGuild')
  );

  if (dangerousGrant) {
    await quarantine(executor,
      `Applied dangerous permission overwrites to #${newChannel.name}`, guild);
  }
});

// ─── ROLE DELETE — block unauthorized role deletion ───────────────────────
client.on('roleDelete', async (role) => {
  const guild = role.guild;
  const executor = await getExecutor(guild, AuditLogEvent.RoleDelete, role.id);
  if (!executor || isImmune(executor)) return;

  const exceeded = trackAction(roleTracker, executor.id, config.ROLE_ACTION_LIMIT, config.ACTION_WINDOW_MS);
  if (exceeded) {
    roleTracker.delete(executor.id);
    await quarantine(executor,
      `Mass role deletion — deleted ${config.ROLE_ACTION_LIMIT}+ roles rapidly`, guild);
    return;
  }

  roleTracker.delete(executor.id);
  await quarantine(executor,
    `Deleted role "${role.name}" without authorization`, guild);
});

// ─── ROLE CREATE — block unauthorized role creation ───────────────────────
client.on('roleCreate', async (role) => {
  const guild = role.guild;
  const executor = await getExecutor(guild, AuditLogEvent.RoleCreate, role.id);
  if (!executor || isImmune(executor)) return;

  const exceeded = trackAction(roleTracker, executor.id, config.ROLE_ACTION_LIMIT, config.ACTION_WINDOW_MS);
  if (exceeded) {
    roleTracker.delete(executor.id);
    await quarantine(executor,
      `Mass role creation — created ${config.ROLE_ACTION_LIMIT}+ roles rapidly`, guild);

    // Try deleting the created role
    await role.delete('Antinuke: unauthorized role creation').catch(() => {});
    return;
  }

  roleTracker.delete(executor.id);
  await quarantine(executor,
    `Created role "${role.name}" without authorization`, guild);
  await role.delete('Antinuke: unauthorized role creation').catch(() => {});
});

// ─── ROLE UPDATE — block dangerous permission grants ──────────────────────
client.on('roleUpdate', async (oldRole, newRole) => {
  const guild = newRole.guild;

  // Check if any dangerous perm was newly granted
  const gained = config.DANGEROUS_PERMS.filter(
    perm => !oldRole.permissions.has(perm) && newRole.permissions.has(perm)
  );
  if (gained.length === 0) return;

  const executor = await getExecutor(guild, AuditLogEvent.RoleUpdate, newRole.id);
  if (!executor || isImmune(executor)) return;

  await quarantine(executor,
    `Granted dangerous permissions (${gained.join(', ')}) to role "${newRole.name}"`, guild);

  // Revert the permissions
  await newRole.setPermissions(oldRole.permissions, 'Antinuke: dangerous perm grant reverted').catch(() => {});
});

// ─── WEBHOOKS — block unauthorized webhook creation ───────────────────────
client.on('webhooksUpdate', async (channel) => {
  const guild = channel.guild;
  if (!guild) return;

  const executor = await getExecutor(guild, AuditLogEvent.WebhookCreate, channel.id);
  if (!executor || isImmune(executor)) return;

  await quarantine(executor,
    `Created a webhook in #${channel.name} without authorization`, guild);

  // Delete any newly created webhooks in that channel
  const webhooks = await channel.fetchWebhooks().catch(() => null);
  if (webhooks) {
    for (const wh of webhooks.values()) {
      if (wh.owner?.id === executor.id) {
        await wh.delete('Antinuke: unauthorized webhook').catch(() => {});
      }
    }
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;

  if (!member.roles.cache.has(config.IMMUNE_ROLE_ID) && member.id !== guild.ownerId) {
    return interaction.reply({ content: '❌ You don\'t have permission to use this command.', ephemeral: true });
  }

  // ── /removequar <user> ────────────────────────────────────────────────────
  if (commandName === 'removequar') {
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: '❌ User not found.', ephemeral: true });

    const quarRole = guild.roles.cache.get(config.QUAR_ROLE_ID);
    if (!quarRole) return interaction.reply({ content: '❌ Quar role not found.', ephemeral: true });

    if (!target.roles.cache.has(config.QUAR_ROLE_ID)) {
      return interaction.reply({ content: `⚠️ ${target.user.tag} is not quarantined.`, ephemeral: true });
    }

    const rolesToRestore = savedRoles.get(target.id);
    if (rolesToRestore?.length > 0) {
      const validRoles = rolesToRestore.filter(id => guild.roles.cache.has(id));
      await target.roles.set(validRoles, `Quar removed + roles restored by ${member.user.tag}`);
      savedRoles.delete(target.id);
    } else {
      await target.roles.remove(quarRole, `Quar removed by ${member.user.tag}`);
    }

    const embed = new EmbedBuilder()
      .setTitle('✅ Quarantine Removed')
      .setColor(0x00CC66)
      .addFields(
        { name: 'User',          value: `${target.user.tag} (<@${target.id}>)`, inline: true },
        { name: 'Removed by',    value: member.user.tag, inline: true },
        { name: 'Roles Restored', value: rolesToRestore?.length > 0 ? `${rolesToRestore.length} role(s) restored` : 'None saved', inline: true },
      )
      .setTimestamp();

    const logChannel = guild.channels.cache.get(config.LOG_CHANNEL_ID);
    if (logChannel) await logChannel.send({ embeds: [embed] }).catch(console.error);

    return interaction.reply({ embeds: [embed] });
  }

  // ── /whitelist <action> <user> ────────────────────────────────────────────
  if (commandName === 'whitelist') {
    const target = interaction.options.getUser('user');
    const action = interaction.options.getString('action');
    if (!target) return interaction.reply({ content: '❌ User not found.', ephemeral: true });

    if (action === 'add') {
      whitelist.add(target.id);
      const embed = new EmbedBuilder()
        .setTitle('🛡️ Whitelist — User Added')
        .setColor(0x00AAFF)
        .addFields(
          { name: 'User',     value: `${target.tag} (<@${target.id}>)`, inline: true },
          { name: 'Added by', value: member.user.tag, inline: true },
        )
        .setTimestamp();
      const logChannel = guild.channels.cache.get(config.LOG_CHANNEL_ID);
      if (logChannel) await logChannel.send({ embeds: [embed] }).catch(console.error);
      return interaction.reply({ embeds: [embed] });
    }

    if (action === 'remove') {
      if (!whitelist.has(target.id)) {
        return interaction.reply({ content: `⚠️ ${target.tag} is not whitelisted.`, ephemeral: true });
      }
      whitelist.delete(target.id);
      const embed = new EmbedBuilder()
        .setTitle('🗑️ Whitelist — User Removed')
        .setColor(0xFF9900)
        .addFields(
          { name: 'User',       value: `${target.tag} (<@${target.id}>)`, inline: true },
          { name: 'Removed by', value: member.user.tag, inline: true },
        )
        .setTimestamp();
      const logChannel = guild.channels.cache.get(config.LOG_CHANNEL_ID);
      if (logChannel) await logChannel.send({ embeds: [embed] }).catch(console.error);
      return interaction.reply({ embeds: [embed] });
    }
  }

  // ── /listwhitelist ────────────────────────────────────────────────────────
  if (commandName === 'listwhitelist') {
    if (whitelist.size === 0) {
      return interaction.reply({ content: 'The whitelist is currently empty.', ephemeral: true });
    }
    const entries = [...whitelist].map(id => `<@${id}> (${id})`).join('\n');
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Current Whitelist')
      .setColor(0x00AAFF)
      .setDescription(entries)
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /quarlist ─────────────────────────────────────────────────────────────
  if (commandName === 'quarlist') {
    const quarRole = guild.roles.cache.get(config.QUAR_ROLE_ID);
    if (!quarRole) return interaction.reply({ content: '❌ Quar role not found.', ephemeral: true });

    await guild.members.fetch();
    const quarred = guild.members.cache.filter(m => m.roles.cache.has(config.QUAR_ROLE_ID));
    if (quarred.size === 0) {
      return interaction.reply({ content: 'No users are currently quarantined.', ephemeral: true });
    }
    const entries = quarred.map(m => `${m.user.tag} (<@${m.id}>)`).join('\n');
    const embed = new EmbedBuilder()
      .setTitle('🔒 Currently Quarantined')
      .setColor(0xFF3333)
      .setDescription(entries)
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[ANTINUKE] Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('removequar')
      .setDescription('Remove quarantine from a user and restore their roles')
      .addUserOption(opt =>
        opt.setName('user').setDescription('The user to unquarantine').setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('whitelist')
      .setDescription('Add or remove a user from the antinuke whitelist')
      .addStringOption(opt =>
        opt.setName('action')
          .setDescription('Add or remove')
          .setRequired(true)
          .addChoices(
            { name: 'Add',    value: 'add'    },
            { name: 'Remove', value: 'remove' },
          )
      )
      .addUserOption(opt =>
        opt.setName('user').setDescription('The user to whitelist/unwhitelist').setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('listwhitelist')
      .setDescription('Show all users on the antinuke whitelist'),

    new SlashCommandBuilder()
      .setName('quarlist')
      .setDescription('Show all currently quarantined users'),

  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.TOKEN);
  try {
    await rest.put(Routes.applicationCommands(config.CLIENT_ID), { body: commands });
    console.log('[ANTINUKE] Slash commands registered globally.');
  } catch (err) {
    console.error('[ANTINUKE] Failed to register commands:', err.message);
  }
});

client.login(config.TOKEN);
