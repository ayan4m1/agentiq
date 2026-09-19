import globals from 'globals';
import eslint from '@eslint/js';
import { configs } from 'typescript-eslint';
import { flatConfigs as importConfigs } from 'eslint-plugin-import-x';
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended';

export default [
  eslint.configs.recommended,
  ...configs.recommended,
  importConfigs.recommended,
  importConfigs.typescript,
  {
    languageOptions: {
      globals: globals.node
    },
    rules: {
      'no-control-regex': 0
    }
  },
  eslintPluginPrettier
];
