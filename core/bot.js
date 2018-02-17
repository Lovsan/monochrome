'use strict'
const reload = require('require-reload')(require);
const Eris = require('eris');
const request = require('request-promise');
const logger = require('./logger.js');
const persistence = require('./persistence.js');
const navigationManager = require('./navigation_manager.js');
const replyDeleter = require('./reply_deleter.js');
const statistics = require('./statistics.js');

const LOGGER_TITLE = 'CORE';
const UPDATE_STATS_INTERVAL_IN_MS = 7200000; // 2 hours
const USER_MENTION_REPLACE_REGEX = /<@user>/g;
const USER_NAME_REPLACE_REGEX = /<user>/g;

let RepeatingQueue;

function validateConfiguration(config) {
  let errorMessage;
  if (!config.botToken) {
    errorMessage = 'Invalid botToken value in configuration (should be non-empty string)';
  } else if (typeof config.serverAdminRoleName !== typeof '') {
    errorMessage = 'Invalid serverAdminRoleName value in configuration (should be string, use empty string for no server entry message)';
  } else if (!config.botAdminIds || !Array.isArray(config.botAdminIds)) {
    errorMessage = 'Invalid botAdminIds value in configuration (should be array of strings)';
  } else if (typeof config.genericErrorMessage !== typeof '') {
    errorMessage = 'Invalid genericErrorMessage value in configuration (should be string, use empty string for no error message)';
  } else if (typeof config.genericDMReply !== typeof '') {
    errorMessage = 'Invalid genericDMReply value in configuration (should be string, use empty string for no DM reply message)';
  } else if (typeof config.genericMentionReply !== typeof '') {
    errorMessage = 'Invalid genericMentionReply value in configuration (should be string, use empty string for no reply message)';
  } else if (typeof config.discordBotsDotOrgAPIKey !== typeof '') {
    errorMessage = 'Invalid discordBotsDotOrgAPIKey value in configuration (should be string, use empty string for no key)';
  } else if (typeof config.useANSIColorsInLogFiles !== typeof true) {
    errorMessage = 'Invalid useANSIColorsInLogFiles value in configuration (should be boolean)';
  } else if (!config.statusRotation || !Array.isArray(config.statusRotation)) {
    errorMessage = 'Invalid statusRotation value in configuration (should be array, use empty array for no status. 1 value array for no rotation.)';
  } else if (typeof config.statusRotationIntervalInSeconds !== typeof 2) {
    errorMessage = 'Invalid statusRotationIntervalInSeconds value in configuration (should be a number of seconds (not a string))';
  } else if (config.botAdminIds.some(id => typeof id !== typeof '')) {
    errorMessage = 'Invalid botAdminId in configuration (should be a string (not a number! put quotes around it))';
  } else if (config.statusRotation.some(status => typeof status !== typeof '')) {
    errorMessage = 'Invalid status in configuration (should be a string)';
  } else if (!config.settingsCategorySeparator || typeof config.settingsCategorySeparator !== typeof '' || config.settingsCategorySeparator.indexOf(' ') !== -1) {
    errorMessage = 'Invalid settingsCategorySeparator in configuration (should be a string with no spaces)';
  } else if (!config.serverSettingsCommandAliases || config.serverSettingsCommandAliases.some(alias => typeof alias !== typeof '')) {
    errorMessage = 'Invalid serverSettingsCommandAliases in configuration (should be an array of strings)';
  } else if (!config.commandsToGenerateHelpFor || !Array.isArray(config.commandsToGenerateHelpFor)) {
    errorMessage = 'Invalid commandsToGenerateHelpFor in configuration (must be an array, can be empty for no auto-generated help)';
  } else if (!config.autoGeneratedHelpCommandAliases || !Array.isArray(config.autoGeneratedHelpCommandAliases)) {
    errorMessage = 'Invalid autoGeneratedHelpCommandAliases in configuration (must be an array, can be empty)';
  } else if (!config.colorForAutoGeneratedHelpEmbeds || typeof config.colorForAutoGeneratedHelpEmbeds !== typeof 1) {
    errorMessage = 'Invalid colorForAutoGeneratedHelpEmbeds in configuration. It must be an integer.';
  }

  if (errorMessage) {
    logger.logFailure('CONFIG', errorMessage);
    throw new Error(errorMessage);
  }
}

function updateDiscordBotsDotOrg(config, bot) {
  if (!config.discordBotsDotOrgAPIKey) {
    return;
  }
  request({
    headers: {
      'Content-Type': 'application/json',
      'Authorization': config.discordBotsDotOrgAPIKey,
      'Accept': 'application/json',
    },
    uri: 'https://discordbots.org/api/bots/' + bot.user.id + '/stats',
    body: '{"server_count": ' + bot.guilds.size.toString() + '}',
    method: 'POST',
  }).then(() => {
    logger.logSuccess(LOGGER_TITLE, 'Sent stats to discordbots.org: ' + bot.guilds.size.toString() + ' servers.');
  }).catch(err => {
    logger.logFailure(LOGGER_TITLE, 'Error sending stats to discordbots.org', err);
  });
}

function updateBotsDotDiscordDotPw(config, bot) {
  if (!config.botsDotDiscordDotPwAPIKey) {
    return;
  }
  request({
    headers: {
      'Content-Type': 'application/json',
      'Authorization': config.botsDotDiscordDotPwAPIKey,
      'Accept': 'application/json',
    },
    uri: 'https://bots.discord.pw/api/bots/' + bot.user.id + '/stats',
    body: '{"server_count": ' + bot.guilds.size.toString() + '}',
    method: 'POST',
  }).then(() => {
    logger.logSuccess(LOGGER_TITLE, 'Sent stats to bots.discord.pw: ' + bot.guilds.size.toString() + ' servers.');
  }).catch(err => {
    logger.logFailure(LOGGER_TITLE, 'Error sending stats to bots.discord.pw', err);
  });
}

function updateStats(config, bot) {
  updateBotsDotDiscordDotPw(config, bot);
  updateDiscordBotsDotOrg(config, bot);
}

function createGuildLeaveJoinLogString(guild) {
  try {
    let owner = guild.members.get(guild.ownerID).user;
    return guild.name + ' owned by ' + owner.username + '#' + owner.discriminator;
  } catch (err) {
    logger.logFailure(LOGGER_TITLE, 'Couldn\'t create join/leave guild log string', err);
    return '<Error getting guild name or owner name>';
  }
}

function stringContainsInviteLink(str) {
  return str.indexOf('discord.gg') !== -1;
}

let botExists = false;
class Monochrome {
  constructor(configFilePath, commandsDirectoryPath, messageProcessorsDirectoryPath, settingsFilePath, logDirectoryPath, onShutdown) {
    if (botExists) {
      throw new Error('This process has already constructed a Monochrome object. You can\'t run multiple bots in one process.');
    }
    botExists = true;
    this.configFilePath_ = configFilePath;
    this.commandsDirectoryPath_ = commandsDirectoryPath;
    this.messageProcessorsDirectoryPath_ = messageProcessorsDirectoryPath;
    this.settingsFilePath_ = settingsFilePath;
    this.onShutdown_ = onShutdown || (() => {});

    this.botMentionString_ = '';
    persistence.init();
    this.config_ = reload(this.configFilePath_);
    logger.initialize(logDirectoryPath, this.config_.useANSIColorsInLogFiles);
    validateConfiguration(this.config_);
    this.bot_ = new Eris(this.config_.botToken);
    statistics.initialize(this.bot_);
    replyDeleter.initialize(Eris);
    this.reloadCore_();
  }

  getErisBot() {
    return this.bot_;
  }

  connect() {
    if (this.connected_) {
      return;
    }
    this.connected_ = true;
    this.bot_.on('ready', () => {
      logger.logSuccess(LOGGER_TITLE, 'Bot ready.');
      this.botMentionString_ = '<@' + this.bot_.user.id + '>';
      this.rotateStatuses_();
      this.startUpdateStatsInterval_();
    });

    this.bot_.on('messageCreate', msg => {
      this.onMessageCreate_(msg);
    });

    this.bot_.on('guildCreate', guild => {
      logger.logSuccess('JOINED GUILD', createGuildLeaveJoinLogString(guild));
    });

    this.bot_.on('error', (err, shardId) => {
      let errorMessage = 'Error';
      if (shardId) {
        errorMessage += ' on shard ' + shardId;
      }
      logger.logFailure(LOGGER_TITLE, errorMessage, err);
    });

    this.bot_.on('disconnect', () => {
      logger.logFailure(LOGGER_TITLE, 'All shards disconnected');
    });

    this.bot_.on('shardDisconnect', (err, id) => {
      logger.logFailure(LOGGER_TITLE, 'Shard ' + id + ' disconnected', err);
    });

    this.bot_.on('shardResume', id => {
      logger.logSuccess(LOGGER_TITLE, 'Shard ' + id + ' reconnected');
    });

    this.bot_.on('warn', message => {
      logger.logFailure(LOGGER_TITLE, 'Warning: ' + message);
    });

    this.bot_.on('shardReady', id => {
      logger.logSuccess(LOGGER_TITLE, 'Shard ' + id + ' connected');
    });

    this.bot_.on('messageReactionAdd', (msg, emoji, userId) => {
      navigationManager.handleEmojiToggled(this.bot_, msg, emoji, userId);
      replyDeleter.handleReaction(msg, userId, emoji);
    });

    this.bot_.on('messageDelete', msg => {
      replyDeleter.handleMessageDeleted(msg);
    });

    this.bot_.on('messageReactionRemove', (msg, emoji, userId) => {
      navigationManager.handleEmojiToggled(this.bot_, msg, emoji, userId);
    });

    this.bot_.on('guildDelete', (guild, unavailable) => {
      if (!unavailable) {
        logger.logFailure('LEFT GUILD', createGuildLeaveJoinLogString(guild));
      }
    });

    this.bot_.connect().catch(err => {
      logger.logFailure(LOGGER_TITLE, 'Error logging in', err);
    });
  }

  onMessageCreate_(msg) {
    try {
      if (!msg.author) {
        return; // Sometimes an empty message with no author appears. *shrug*
      }
      if (msg.author.bot) {
        return;
      }
      if (this.commandManager_.processInput(this.bot_, msg)) {
        return;
      }
      if (this.messageProcessorManager_.processInput(this.bot_, msg, this.config_)) {
        return;
      }
      if (this.tryHandleDm_(msg)) {
        return;
      }
      if (this.tryHandleMention_(msg)) {
        return;
      }
    } catch (err) {
      logger.logFailure(LOGGER_TITLE, 'Error caught at top level', err);
      if (this.config_.genericErrorMessage) {
        msg.channel.createMessage(this.config_.genericErrorMessage);
      }
    }
  }

  reloadCore_() {
    this.config_ = reload(this.configFilePath_);
    validateConfiguration(this.config_);
    logger.reload();
    persistence.reload();
    navigationManager.reload();

    RepeatingQueue = reload('./repeating_queue.js');
    this.statusQueue_ = new RepeatingQueue(this.config_.statusRotation);
    this.settingsManager_ = new (reload('./settings_manager.js'))(logger, this.config_);
    let settingsManagerCommands = this.settingsManager_.collectCommands();
    let settingsGetter = this.settingsManager_.createSettingsGetter();
    this.messageProcessorManager_ = new (reload('./message_processor_manager.js'))(logger);
    this.commandManager_ = new (reload('./command_manager.js'))(() => this.reloadCore_(), () => this.shutdown_(), logger, this.config_, settingsGetter);
    this.commandManager_.load(this.commandsDirectoryPath_, settingsManagerCommands).then(() => {
      let settingsFilePaths = [];
      if (this.settingsFilePath_) {
        settingsFilePaths.push(this.settingsFilePath_);
      }
      this.settingsManager_.load(this.commandManager_.collectSettingsCategories(), settingsFilePaths, this.config_);
    }).catch(err => {
      logger.logFailure(LOGGER_TITLE, 'Error loading command manager', err);
    });
    this.messageProcessorManager_.load(this.messageProcessorsDirectoryPath_);
  }

  shutdown_() {
    logger.logSuccess(LOGGER_TITLE, 'Shutting down.');
    try {
      Promise.resolve(this.onShutdown_(this.bot_)).catch(err => {
        logger.logFailure(LOGGER_TITLE, 'The promise returned from a custom onShutdown handler rejected. Continuing shutdown.', err);
      }).then(() => {
        this.bot_.disconnect();
        process.exit();
      });
    } catch (err) {
      logger.logFailure(LOGGER_TITLE, 'The custom onShutdown handler threw. Continuing shutdown.', err);
      this.bot_.disconnect();
      process.exit();
    }
  }

  startUpdateStatsInterval_() {
    if (this.updateStatsTimeoutHandle_) {
      return;
    }
    if (this.config_.discordBotsDotOrgAPIKey || this.config_.botsDotDiscordDotPwAPIKey) {
      updateStats(this.config_, this.bot_);
      this.updateStatsTimeoutHandle_ = setInterval(updateStats, UPDATE_STATS_INTERVAL_IN_MS, this.config_, this.bot_);
    }
  }

  rotateStatuses_() {
    try {
      if (this.rotateStatusesTimeoutHandle_) {
        clearTimeout(this.rotateStatusesTimeoutHandle_);
      }
      if (this.config_.statusRotation.length > 0) {
        if (this.config_.statusRotation.length > 1) {
          this.rotateStatusesTimeoutHandle_ = setTimeout(() => this.rotateStatuses_(), this.config_.statusRotationIntervalInSeconds * 1000);
        }

        let nextStatus = this.statusQueue_.pop();
        this.bot_.editStatus({name: nextStatus});
      }
    } catch (err) {
      logger.logFailure(LOGGER_TITLE, 'Error rotating statuses', err);
    }
  }

  tryHandleDm_(msg) {
    try {
      if (!msg.channel.guild) {
        logger.logInputReaction('DIRECT MESSAGE', msg, '', true);
        if (this.config_.inviteLinkDmReply && stringContainsInviteLink(msg.content)) {
          msg.channel.createMessage(this.createDMOrMentionReply_(this.config_.inviteLinkDmReply, msg));
        } else if (this.config_.genericDMReply) {
          msg.channel.createMessage(this.createDMOrMentionReply_(this.config_.genericDMReply, msg));
        }
        return true;
      }
    } catch (err) {
      logger.logFailure(LOGGER_TITLE, 'Error handling DM', err);
    }

    return false;
  }

  tryHandleMention_(msg) {
    try {
      if (msg.mentions.length > 0 && msg.content.indexOf(this.botMentionString_) === 0 && this.config_.genericMentionReply) {
        msg.channel.createMessage(this.createDMOrMentionReply_(this.config_.genericMentionReply, msg));
        logger.logInputReaction('MENTION', msg, '', true);
        return true;
      }
    } catch (err) {
      logger.logFailure(LOGGER_TITLE, 'Error handling mention', err);
    }

    return false;
  }

  createDMOrMentionReply_(configReply, msg) {
    try {
      let reply = configReply.replace(USER_MENTION_REPLACE_REGEX, '<@' + msg.author.id + '>');
      reply = reply.replace(USER_NAME_REPLACE_REGEX, msg.author.username);
      return reply;
    } catch (err) {
      logger.logFailure(LOGGER_TITLE, 'Couldn\'t create DM or mention reply', err);
      return this.config_.genericErrorMessage;
    }
  }
}

module.exports = Monochrome;
