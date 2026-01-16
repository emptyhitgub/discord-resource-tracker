require('dotenv').config();

const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Bot configuration
const TOKEN = process.env.DISCORD_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE'; // Use environment variable
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '927071447300571137';

// File path for persistent storage
const DATA_FILE = path.join(__dirname, 'playerData.json');

// In-memory storage for player resources
let playerData = new Map();

// Active encounter data
let activeEncounter = {
    active: false,
    combatants: [] // Array of userIds
};

// Resource types
const RESOURCES = ['HP', 'MP', 'IP', 'Armor', 'Barrier'];

// Resource emojis
const RESOURCE_EMOJIS = {
    HP: '❤️',
    MP: '💧',
    IP: '💰',
    Armor: '💥',
    Barrier: '🛡️'
};

// Load data from file
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            const parsed = JSON.parse(rawData);
            playerData = new Map(Object.entries(parsed.players || parsed));
            activeEncounter = parsed.encounter || { active: false, combatants: [] };
            console.log(`Loaded data for ${playerData.size} players from ${DATA_FILE}`);
        } else {
            console.log('No existing data file found. Starting fresh.');
        }
    } catch (error) {
        console.error('Error loading data:', error);
        console.log('Starting with empty data.');
    }
}

// Save data to file
function saveData() {
    try {
        const dataObject = {
            players: Object.fromEntries(playerData),
            encounter: activeEncounter
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataObject, null, 2), 'utf8');
        console.log(`Data saved for ${playerData.size} players`);
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

// Initialize player data
function initPlayer(userId, displayName, characterName = null) {
    if (!playerData.has(userId)) {
        playerData.set(userId, {
            username: displayName,
            characterName: characterName || displayName,
            HP: 0,
            MP: 0,
            IP: 0,
            Armor: 0,
            Barrier: 0,
            maxHP: 0,
            maxMP: 0,
            maxIP: 0,
            maxArmor: 0,
            maxBarrier: 0,
            statusEffects: []  // Array of {name: string, duration: number}
        });
    } else {
        // Update display name in case it changed
        playerData.get(userId).username = displayName;
        // Update character name if provided
        if (characterName) {
            playerData.get(userId).characterName = characterName;
        }
    }
}

// Create the bot client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});

// Define slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('set')
        .setDescription('Set a player\'s MAX resource values')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player to set resources for')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Character name (for display)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('hp')
                .setDescription('Max HP value')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('mp')
                .setDescription('Max MP value')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('ip')
                .setDescription('Max IP value')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('armor')
                .setDescription('Max Armor value')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('barrier')
                .setDescription('Max Barrier value')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('view')
        .setDescription('View a player\'s current resources')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player to view (leave empty for yourself)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('update')
        .setDescription('Add or subtract from a resource')
        .addStringOption(option =>
            option.setName('resource')
                .setDescription('The resource to update')
                .setRequired(true)
                .addChoices(
                    { name: 'HP', value: 'HP' },
                    { name: 'MP', value: 'MP' },
                    { name: 'IP', value: 'IP' },
                    { name: 'Armor', value: 'Armor' },
                    { name: 'Barrier', value: 'Barrier' }
                ))
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Amount to add (positive) or subtract (negative)')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player to update (leave empty for yourself)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('status')
        .setDescription('Add a status effect (buff/debuff) to a player')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Name of the status effect (e.g., Bleed, Haste, Poisoned)')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('duration')
                .setDescription('Duration in turns')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player to apply status to (leave empty for yourself)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('removestatus')
        .setDescription('Remove a status effect from a player')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Name of the status effect to remove')
                .setRequired(true))
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player to remove status from (leave empty for yourself)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('tick')
        .setDescription('Advance your turn by 1 (reduces YOUR status durations by 1)'),

    new SlashCommandBuilder()
        .setName('hp')
        .setDescription('Update your HP quickly')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount to change (use "full" to restore to max)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('mp')
        .setDescription('Update your MP quickly')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount to change (use "full" to restore to max)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('ip')
        .setDescription('Update your IP quickly')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount to change (use "full" to restore to max)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('armor')
        .setDescription('Update your Armor quickly')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount to change (use "full" to restore to max)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('barrier')
        .setDescription('Update your Barrier quickly')
        .addStringOption(option =>
            option.setName('amount')
                .setDescription('Amount to change (use "full" to restore to max)')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('rest')
        .setDescription('Restore all your resources to maximum'),

    new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset all player data (GM only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('listall')
        .setDescription('List all players and their resources'),

    new SlashCommandBuilder()
        .setName('viewall')
        .setDescription('View all players and their resources in detail'),

    new SlashCommandBuilder()
        .setName('startencounter')
        .setDescription('Start a new encounter (GM only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('endencounter')
        .setDescription('End the current encounter (GM only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    new SlashCommandBuilder()
        .setName('addcombatant')
        .setDescription('Add a player to the active encounter')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player to add (leave empty to add yourself)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('removecombatant')
        .setDescription('Remove a player from the active encounter')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player to remove')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('guide')
        .setDescription('Show all available bot commands and how to use them')
].map(command => command.toJSON());

// Register commands
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();

// Bot ready event
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    console.log('Resource Tracker Bot is online!');
    loadData(); // Load saved data when bot starts
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
        if (commandName === 'set') {
            const player = interaction.options.getUser('player');
            const playerMember = await interaction.guild.members.fetch(player.id);
            const characterName = interaction.options.getString('name');
            const newMaxHP = interaction.options.getInteger('hp');
            const newMaxMP = interaction.options.getInteger('mp');
            const newMaxIP = interaction.options.getInteger('ip');
            const newMaxArmor = interaction.options.getInteger('armor');
            const newMaxBarrier = interaction.options.getInteger('barrier');

            initPlayer(player.id, playerMember.displayName, characterName);
            const data = playerData.get(player.id);
            
            // Get current IP to preserve it
            const currentIP = data.IP || 0;

            // Update max values
            data.maxHP = newMaxHP;
            data.maxMP = newMaxMP;
            data.maxIP = newMaxIP;
            data.maxArmor = newMaxArmor;
            data.maxBarrier = newMaxBarrier;

            // Set HP and MP to new max, keep IP, reset Armor and Barrier
            data.HP = newMaxHP;
            data.MP = newMaxMP;
            data.IP = currentIP; // Preserve current IP
            data.Armor = 0;
            data.Barrier = 0;

            data.username = playerMember.displayName;
            data.characterName = characterName;

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`✨ Max Resources Set for ${characterName}`)
                .setDescription('HP and MP restored to new max. IP preserved. Armor and Barrier reset to 0.')
                .addFields(
                    { name: `${RESOURCE_EMOJIS.HP} HP`, value: `${data.HP}/${data.maxHP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.MP} MP`, value: `${data.MP}/${data.maxMP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.IP} IP`, value: `${data.IP}/${data.maxIP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Armor} Armor`, value: `${data.Armor}/${data.maxArmor}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Barrier} Barrier`, value: `${data.Barrier}/${data.maxBarrier}`, inline: true }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'view') {
            const player = interaction.options.getUser('player') || interaction.user;
            const playerMember = await interaction.guild.members.fetch(player.id);
            
            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);

            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`${data.characterName}'s Resources`)
                .addFields(
                    { name: `${RESOURCE_EMOJIS.HP} HP`, value: `${data.HP}/${data.maxHP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.MP} MP`, value: `${data.MP}/${data.maxMP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.IP} IP`, value: `${data.IP}/${data.maxIP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Armor} Armor`, value: `${data.Armor}/${data.maxArmor}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Barrier} Barrier`, value: `${data.Barrier}/${data.maxBarrier}`, inline: true }
                )
                .setTimestamp();

            // Add status effects if any
            if (data.statusEffects && data.statusEffects.length > 0) {
                const statusText = data.statusEffects
                    .map(s => `**${s.name}** (${s.duration} turns)`)
                    .join('\n');
                embed.addFields({ name: '🔮 Status Effects', value: statusText, inline: false });
            }

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'update') {
            const player = interaction.options.getUser('player') || interaction.user;
            const playerMember = await interaction.guild.members.fetch(player.id);
            const resource = interaction.options.getString('resource');
            const amount = interaction.options.getInteger('amount');

            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);
            
            const oldValue = data[resource];
            const maxValue = data[`max${resource}`];
            data[resource] += amount;
            const newValue = data[resource];

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(amount > 0 ? 0x00FF00 : 0xFF0000)
                .setTitle(`${data.characterName}'s ${RESOURCE_EMOJIS[resource]} ${resource} Updated`)
                .setDescription(`${oldValue} ${amount > 0 ? '+' : ''}${amount} = **${newValue}/${maxValue}**`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (['hp', 'mp', 'ip', 'armor', 'barrier'].includes(commandName)) {
            const player = interaction.user;
            const playerMember = interaction.member;
            const resourceLower = commandName;
            // Map command names to proper resource names in data
            const resourceMap = {
                'hp': 'HP',
                'mp': 'MP',
                'ip': 'IP',
                'armor': 'Armor',
                'barrier': 'Barrier'
            };
            const resource = resourceMap[resourceLower];
            const amountStr = interaction.options.getString('amount');

            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);

            // Handle "full" command
            if (amountStr.toLowerCase() === 'full') {
                const oldValue = data[resource];
                const maxValue = data[`max${resource}`];
                data[resource] = maxValue;

                saveData(); // Save after modification

                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle(`${data.characterName}'s ${RESOURCE_EMOJIS[resource]} ${resource} Restored!`)
                    .setDescription(`${oldValue}/${maxValue} → **${maxValue}/${maxValue}**`)
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
                return;
            }

            // Parse amount
            const amount = parseInt(amountStr);
            if (isNaN(amount)) {
                await interaction.reply({ content: 'Please enter a valid number or "full"', ephemeral: true });
                return;
            }

            const oldValue = data[resource];
            const maxValue = data[`max${resource}`];
            data[resource] += amount;
            const newValue = data[resource];

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(amount > 0 ? 0x00FF00 : 0xFF0000)
                .setTitle(`${data.characterName}'s ${RESOURCE_EMOJIS[resource]} ${resource} Updated`)
                .setDescription(`${oldValue} ${amount > 0 ? '+' : ''}${amount} = **${newValue}/${maxValue}**`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'rest') {
            const player = interaction.user;
            const playerMember = interaction.member;
            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);

            data.HP = data.maxHP;
            data.MP = data.maxMP;
            // IP stays as is
            data.Armor = 0;
            data.Barrier = 0;

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`✨ ${data.characterName} Rested!`)
                .setDescription('HP and MP restored. IP stays. Armor and Barrier reset to 0.')
                .addFields(
                    { name: `${RESOURCE_EMOJIS.HP} HP`, value: `${data.HP}/${data.maxHP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.MP} MP`, value: `${data.MP}/${data.maxMP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.IP} IP`, value: `${data.IP}/${data.maxIP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Armor} Armor`, value: `${data.Armor}/${data.maxArmor}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.Barrier} Barrier`, value: `${data.Barrier}/${data.maxBarrier}`, inline: true }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'status') {
            const player = interaction.options.getUser('player') || interaction.user;
            const playerMember = player.id === interaction.user.id 
                ? interaction.member 
                : await interaction.guild.members.fetch(player.id);
            const statusName = interaction.options.getString('name');
            const duration = interaction.options.getInteger('duration');

            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);

            // Check if status already exists
            const existingIndex = data.statusEffects.findIndex(s => s.name.toLowerCase() === statusName.toLowerCase());
            
            if (existingIndex !== -1) {
                // Update existing status duration
                data.statusEffects[existingIndex].duration = duration;
                
                saveData(); // Save after modification

                const embed = new EmbedBuilder()
                    .setColor(0xFFAA00)
                    .setTitle(`🔄 Status Updated`)
                    .setDescription(`**${statusName}** on ${data.characterName} updated to ${duration} turns`)
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
            } else {
                // Add new status
                data.statusEffects.push({ name: statusName, duration: duration });

                saveData(); // Save after modification

                const embed = new EmbedBuilder()
                    .setColor(0xFF6B6B)
                    .setTitle(`✨ Status Applied`)
                    .setDescription(`**${statusName}** applied to ${data.characterName} for ${duration} turns`)
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
            }

        } else if (commandName === 'removestatus') {
            const player = interaction.options.getUser('player') || interaction.user;
            const playerMember = player.id === interaction.user.id 
                ? interaction.member 
                : await interaction.guild.members.fetch(player.id);
            const statusName = interaction.options.getString('name');

            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);

            const index = data.statusEffects.findIndex(s => s.name.toLowerCase() === statusName.toLowerCase());

            if (index === -1) {
                await interaction.reply({ content: `${data.characterName} doesn't have the status **${statusName}**`, ephemeral: true });
                return;
            }

            data.statusEffects.splice(index, 1);

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle(`🗑️ Status Removed`)
                .setDescription(`**${statusName}** removed from ${data.characterName}`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'tick') {
            const player = interaction.user;
            const playerMember = interaction.member;
            initPlayer(player.id, playerMember.displayName);
            const data = playerData.get(player.id);

            if (!data.statusEffects || data.statusEffects.length === 0) {
                await interaction.reply({ content: 'You have no status effects to tick.', ephemeral: true });
                return;
            }

            const beforeCount = data.statusEffects.length;
            
            // Reduce all durations by 1
            data.statusEffects.forEach(status => {
                status.duration -= 1;
            });

            // Track expired statuses
            const expired = data.statusEffects.filter(s => s.duration <= 0);

            // Remove statuses with duration <= 0
            data.statusEffects = data.statusEffects.filter(s => s.duration > 0);
            
            const totalExpired = beforeCount - data.statusEffects.length;

            saveData(); // Save after modification

            const embed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle(`⏰ ${data.characterName}'s Turn Advanced`)
                .setDescription(`All your status effect durations reduced by 1`)
                .setTimestamp();

            if (expired.length > 0) {
                const expiredText = expired.map(s => s.name).join(', ');
                embed.addFields({ name: '💨 Expired Status Effects', value: expiredText, inline: false });
            }

            if (data.statusEffects.length > 0) {
                const remainingText = data.statusEffects
                    .map(s => `**${s.name}** (${s.duration} turns)`)
                    .join('\n');
                embed.addFields({ name: '🔮 Remaining Status Effects', value: remainingText, inline: false });
            }

            embed.setFooter({ text: `${totalExpired} status effect(s) expired` });

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'reset') {
            playerData.clear();
            saveData(); // Save after clearing
            
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('⚠️ All Player Data Reset')
                .setDescription('All player resources have been cleared and file deleted.')
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'listall') {
            if (!activeEncounter.active) {
                await interaction.reply('No active encounter. Use `/startencounter` to begin.');
                return;
            }

            if (activeEncounter.combatants.length === 0) {
                await interaction.reply('No combatants in the current encounter. Use `/addcombatant` to add players.');
                return;
            }

            const embed = new EmbedBuilder()
                .setColor(0xFFFFFF)
                .setTitle('⚔️ Active Encounter - Combatants')
                .setTimestamp();

            for (const userId of activeEncounter.combatants) {
                const data = playerData.get(userId);
                if (!data) continue;

                let valueText = `${RESOURCE_EMOJIS.HP} HP: ${data.HP}/${data.maxHP} | ${RESOURCE_EMOJIS.MP} MP: ${data.MP}/${data.maxMP} | ${RESOURCE_EMOJIS.IP} IP: ${data.IP}/${data.maxIP} | ${RESOURCE_EMOJIS.Armor} Armor: ${data.Armor}/${data.maxArmor} | ${RESOURCE_EMOJIS.Barrier} Barrier: ${data.Barrier}/${data.maxBarrier}`;
                
                if (data.statusEffects && data.statusEffects.length > 0) {
                    const statusText = data.statusEffects
                        .map(s => `${s.name} (${s.duration})`)
                        .join(', ');
                    valueText += `\n🔮 ${statusText}`;
                }

                embed.addFields({
                    name: data.characterName,
                    value: valueText,
                    inline: false
                });
            }

            embed.setFooter({ text: `${activeEncounter.combatants.length} combatant(s) in encounter` });

            await interaction.reply({ embeds: [embed] });
        } else if (commandName === 'viewall') {
            if (playerData.size === 0) {
                await interaction.reply('No player data available yet.');
                return;
            }

            const embed = new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle('📊 All Players - Resources Overview')
                .setTimestamp();

            for (const [userId, data] of playerData) {
                const resourceText = `${RESOURCE_EMOJIS.HP} **HP:** ${data.HP}/${data.maxHP}\n${RESOURCE_EMOJIS.MP} **MP:** ${data.MP}/${data.maxMP}\n${RESOURCE_EMOJIS.IP} **IP:** ${data.IP}/${data.maxIP}\n${RESOURCE_EMOJIS.Armor} **Armor:** ${data.Armor}/${data.maxArmor}\n${RESOURCE_EMOJIS.Barrier} **Barrier:** ${data.Barrier}/${data.maxBarrier}`;
                
                let fieldValue = resourceText;
                if (data.statusEffects && data.statusEffects.length > 0) {
                    const statusText = data.statusEffects
                        .map(s => `${s.name} (${s.duration})`)
                        .join(', ');
                    fieldValue += `\n🔮 ${statusText}`;
                }

                embed.addFields({
                    name: `👤 ${data.characterName}`,
                    value: fieldValue,
                    inline: true
                });
            }

            await interaction.reply({ embeds: [embed] });
        } else if (commandName === 'startencounter') {
            if (activeEncounter.active) {
                await interaction.reply({ content: 'An encounter is already active! Use `/endencounter` to end it first.', ephemeral: true });
                return;
            }

            activeEncounter.active = true;
            activeEncounter.combatants = [];
            saveData();

            const embed = new EmbedBuilder()
                .setColor(0xFF6B6B)
                .setTitle('⚔️ Encounter Started!')
                .setDescription('Use `/addcombatant` to add players to this encounter.\nUse `/listall` to view active combatants.')
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'endencounter') {
            if (!activeEncounter.active) {
                await interaction.reply({ content: 'No active encounter to end.', ephemeral: true });
                return;
            }

            const combatantCount = activeEncounter.combatants.length;
            activeEncounter.active = false;
            activeEncounter.combatants = [];
            saveData();

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('✅ Encounter Ended')
                .setDescription(`Encounter completed with ${combatantCount} combatant(s).`)
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'addcombatant') {
            if (!activeEncounter.active) {
                await interaction.reply({ content: 'No active encounter. Use `/startencounter` first.', ephemeral: true });
                return;
            }

            const player = interaction.options.getUser('player') || interaction.user;
            const playerMember = await interaction.guild.members.fetch(player.id);

            if (!playerData.has(player.id)) {
                await interaction.reply({ content: `${playerMember.displayName} doesn't have character data. Use \`/set\` to create their character first.`, ephemeral: true });
                return;
            }

            if (activeEncounter.combatants.includes(player.id)) {
                await interaction.reply({ content: `${playerData.get(player.id).characterName} is already in the encounter!`, ephemeral: true });
                return;
            }

            activeEncounter.combatants.push(player.id);
            saveData();

            const data = playerData.get(player.id);
            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('➕ Combatant Added')
                .setDescription(`**${data.characterName}** joined the encounter!`)
                .addFields(
                    { name: `${RESOURCE_EMOJIS.HP} HP`, value: `${data.HP}/${data.maxHP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.MP} MP`, value: `${data.MP}/${data.maxMP}`, inline: true },
                    { name: `${RESOURCE_EMOJIS.IP} IP`, value: `${data.IP}/${data.maxIP}`, inline: true }
                )
                .setFooter({ text: `${activeEncounter.combatants.length} combatant(s) in encounter` })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'removecombatant') {
            if (!activeEncounter.active) {
                await interaction.reply({ content: 'No active encounter.', ephemeral: true });
                return;
            }

            const player = interaction.options.getUser('player');
            const index = activeEncounter.combatants.indexOf(player.id);

            if (index === -1) {
                await interaction.reply({ content: 'That player is not in the encounter.', ephemeral: true });
                return;
            }

            activeEncounter.combatants.splice(index, 1);
            saveData();

            const data = playerData.get(player.id);
            const characterName = data ? data.characterName : player.username;

            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('➖ Combatant Removed')
                .setDescription(`**${characterName}** left the encounter.`)
                .setFooter({ text: `${activeEncounter.combatants.length} combatant(s) remaining` })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });

        } else if (commandName === 'guide') {
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('📖 Command Guide')
                .addFields(
                    {
                        name: '⚙️ /set',
                        value: 'Set max resources for a player\n' +
                               '**Usage:** `/set @player name:CharacterName hp:100 mp:50 ip:10 armor:20 barrier:15`',
                        inline: false
                    },
                    {
                        name: '⚔️ Encounter Commands',
                        value: '`/startencounter` - Start a new encounter (GM only)\n' +
                               '`/addcombatant` - Add player to encounter: `/addcombatant @player`\n' +
                               '`/removecombatant` - Remove player from encounter\n' +
                               '`/endencounter` - End the encounter (GM only)',
                        inline: false
                    },
                    {
                        name: '📋 /listall',
                        value: 'View all combatants in the **active encounter**',
                        inline: false
                    },
                    {
                        name: '👥 /viewall',
                        value: 'View **all registered characters** (not just in encounter)',
                        inline: false
                    },
                    {
                        name: '⚡ Quick Commands',
                        value: '`/hp`, `/mp`, `/ip`, `/armor`, `/barrier`\n' +
                               '**Usage:** `/hp -10` to subtract or `/mp full` to restore to max',
                        inline: false
                    },
                    {
                        name: '✨ Special Actions',
                        value: '`/rest` - Restore HP/MP to max, reset Armor/Barrier to 0\n' +
                               '`/status` - Add status effect: `/status name:Poisoned duration:3`\n' +
                               '`/removestatus` - Remove status: `/removestatus name:Poisoned`\n' +
                               '`/tick` - Advance your turn (reduce status durations by 1)',
                        inline: false
                    }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        }
    } catch (error) {
        console.error(error);
        await interaction.reply({ content: 'An error occurred while processing the command.', ephemeral: true });
    }
});

// Login to Discord
client.login(TOKEN);