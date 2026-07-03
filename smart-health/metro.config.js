// Metro configuration — extends Expo's default to bundle .onnx model files
// as static assets (so on-device inference adapters can load them via
// expo-asset).
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Treat .onnx as a bundleable asset, not a JS source file.
config.resolver.assetExts = [...config.resolver.assetExts, 'onnx'];

module.exports = config;
