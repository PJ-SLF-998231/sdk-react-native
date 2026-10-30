// Resolve the SDK from the repo (it is linked with a file: dependency), and make sure there is exactly one copy of
// react / react-native: the SDK's own devDependencies must not shadow the example's.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [sdkRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
