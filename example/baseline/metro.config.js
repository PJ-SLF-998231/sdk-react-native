// Resolves expo / react / react-native from ../node_modules (the example's install); no SDK.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '..')];
module.exports = config;
