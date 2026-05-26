const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField, REST, Routes, SlashCommandBuilder } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildBans,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const config = {
  TOKEN: process.env.TOKEN,                    // set this in your environment variables
  CLIENT_ID: 'YOUR_CLIENT_ID_HERE',            // paste your Application ID here

  // Role given when someone is quarantined
  QUAR_ROLE_ID: '1508968420933370017',

  // Role that grants immunity (staff/trusted role)
  IMMUNE_ROLE_ID: '1506430627501703249',

  // Channel to log antinuke actions
  LOG_CHANNEL_ID: '1508973950573613146',

  // Ping flood settings
  PING_LIMIT: 10,        // how many pings triggers quar
  PING_WINDOW_MS: 25000, // 25 second window
};

// ─── STATE ────────────────────────────────────────────────────────────────────
// Track pings per user: Map<userId, { count, firstPingAt }>
const pingTracker = new Map();

// Whitelisted user IDs (immune from all antinuke)
const whitelist = new Set();

// Saved roles before quar: Map<userId, Role[]>
const savedRoles = new Map();

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function isImmune(member) {
  if (!member) return false;
  if (whitelist.has(member.id)) return true;
  if (member.roles.cache.has(config.IMMUNE_ROLE_ID)) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return false;
}

async function quarantine(member, reason, guild) {
  try {
    const quarRole = guild.roles.cache.get(config.QUAR_ROLE_ID);
    if (!quarRole) return console.error('[ANTINUKE] Quar role not found!');

    // Save all current roles (except @everyone) before removing them
    const currentRoles = member.roles.cache.filter(r => r.id !== guild.id);
    savedRoles.set(member.id, currentRoles.map(r => r.id));

    // Remove all roles then add quar role
    await member.roles.set([quarRole], `Antinuke: ${reason}`);

    await sendLog(guild, member, reason);
  } catch (err) {
    console.error('[ANTINUKE] Failed to quarantine:', err.message);
  }
}

async function sendLog(guild, member, reason) {
  const logChannel = guild.channels.cache.get(config.LOG_CHANNEL_ID);
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setTitle('🔒 Antinuke — User Quarantined')
    .setColor(0xFF3333)
    .addFields(
      { name: 'User', value: `${member.user.tag} (<@${member.id}>)`, inline: true },
      { name: 'ID', value: member.id, inline: true },
      { name: 'Reason', value: reason },
    )
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();

  await logChannel.send({ embeds: [embed] }).catch(console.error);
}

// ─── MESSAGE CREATE (ping flood + invite link detection) ─────────────────────
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  // ── 1. Ping flood detection ────────────────────────────────────────────────
  const mentionCount = message.mentions.users.size + message.mentions.roles.size;

  if (mentionCount > 0) {
    const now = Date.now();
    const tracker = pingTracker.get(member.id) || { count: 0, firstPingAt: now };

    // Reset window if expired
    if (now - tracker.firstPingAt > config.PING_WINDOW_MS) {
      tracker.count = 0;
      tracker.firstPingAt = now;
    }

    tracker.count += mentionCount;
    pingTracker.set(member.id, tracker);

    if (tracker.count >= config.PING_LIMIT) {
      if (!isImmune(member)) {
        pingTracker.delete(member.id);
        await message.delete().catch(() => {});
        await quarantine(member, `Ping flood — sent ${tracker.count} pings in under 25 seconds`, message.guild);
      }
    }
  }

  // ── 2. Discord invite link detection ──────────────────────────────────────
  const inviteRegex = /discord(?:\.gg|app\.com\/invite|\.com\/invite)\/[a-zA-Z0-9\-_]+/i;
  if (inviteRegex.test(message.content)) {
    if (!isImmune(member)) {
      await message.delete().catch(() => {});
      await quarantine(member, 'Sent a Discord invite link without permission', message.guild);
    }
  }
});

// ─── GUILD MEMBER ADD (bot invite detection) ──────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  if (!member.user.bot) return;

  const guild = member.guild;
  await new Promise(r => setTimeout(r, 1000)); // wait 1s for audit log to populate

  const auditLogs = await guild.fetchAuditLogs({ type: 28 /* BOT_ADD */, limit: 5 }).catch(() => null);
  if (!auditLogs) return;

  const entry = auditLogs.entries.find(e => e.target?.id === member.id);
  if (!entry) return;

  const executor = await guild.members.fetch(entry.executor.id).catch(() => null);
  if (!executor) return;

  if (!isImmune(executor)) {
    await quarantine(executor, `Invited bot ${member.user.tag} (${member.id}) without being whitelisted`, guild);
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;

  // Only allow admins or immune roles to use these commands
  if (!member.permissions.has(PermissionsBitField.Flags.Administrator) && !member.roles.cache.has(config.IMMUNE_ROLE_ID)) {
    return interaction.reply({ content: '❌ You don\'t have permission to use this command.', ephemeral: true });
  }

  // /removequar <user>
  if (commandName === 'removequar') {
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: '❌ User not found.', ephemeral: true });

    const quarRole = guild.roles.cache.get(config.QUAR_ROLE_ID);
    if (!quarRole) return interaction.reply({ content: '❌ Quar role not found in this server.', ephemeral: true });

    if (!target.roles.cache.has(config.QUAR_ROLE_ID)) {
      return interaction.reply({ content: `⚠️ ${target.user.tag} is not quarantined.`, ephemeral: true });
    }

    // Restore their old roles if we have them saved
    const rolesToRestore = savedRoles.get(target.id);
    if (rolesToRestore && rolesToRestore.length > 0) {
      const validRoles = rolesToRestore.filter(id => guild.roles.cache.has(id));
      await target.roles.set(validRoles, `Quar removed + roles restored by ${member.user.tag}`);
      savedRoles.delete(target.id);
    } else {
      // No saved roles, just remove quar role
      await target.roles.remove(quarRole, `Quar removed by ${member.user.tag}`);
    }

    const embed = new EmbedBuilder()
      .setTitle('✅ Quarantine Removed')
      .setColor(0x00CC66)
      .addFields(
        { name: 'User', value: `${target.user.tag} (<@${target.id}>)`, inline: true },
        { name: 'Removed by', value: `${member.user.tag}`, inline: true },
        { name: 'Roles Restored', value: rolesToRestore?.length > 0 ? `${rolesToRestore.length} role(s) restored` : 'No saved roles found', inline: true },
      )
      .setTimestamp();

    const logChannel = guild.channels.cache.get(config.LOG_CHANNEL_ID);
    if (logChannel) await logChannel.send({ embeds: [embed] }).catch(console.error);

    return interaction.reply({ embeds: [embed] });
  }

  // /whitelist <user>
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
          { name: 'User', value: `${target.tag} (<@${target.id}>)`, inline: true },
          { name: 'Added by', value: `${member.user.tag}`, inline: true },
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
          { name: 'User', value: `${target.tag} (<@${target.id}>)`, inline: true },
          { name: 'Removed by', value: `${member.user.tag}`, inline: true },
        )
        .setTimestamp();

      const logChannel = guild.channels.cache.get(config.LOG_CHANNEL_ID);
      if (logChannel) await logChannel.send({ embeds: [embed] }).catch(console.error);

      return interaction.reply({ embeds: [embed] });
    }
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
            { name: 'Add', value: 'add' },
            { name: 'Remove', value: 'remove' },
          )
      )
      .addUserOption(opt =>
        opt.setName('user').setDescription('The user to whitelist/unwhitelist').setRequired(true)
      ),
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
