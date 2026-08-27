import { defineConfig } from 'eslint/config'
import eslintConfigXo from 'eslint-config-xo'
import sonarjs from 'eslint-plugin-sonarjs'
import boundaries from 'eslint-plugin-boundaries'
import globals from 'globals'

export default defineConfig([
  ...eslintConfigXo({
    space: true,
    semicolon: false,
    prettier: 'compat',
    gitignore: import.meta.url
  }),

  {
    ignores: ['node_modules/**', '.opencode/**', 'AGENTS.md', 'REVIEW.md', 'SCORING.md']
  },

  {
    files: ['**/*.{ts,mjs,js}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node
    },
    settings: {
      'import-x/resolver': {
        typescript: true
      },
      'boundaries/files': [
        { pattern: 'plugins/opencode-learning/index.ts', category: 'entry' },
        { pattern: 'plugins/opencode-learning/scoring.ts', category: 'core' }
      ]
    },
    plugins: {
      sonarjs,
      boundaries
    },
    rules: {
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'max-lines-per-function': ['error', 60],
      'sonarjs/cognitive-complexity': ['error', 12],
      'import-x/no-cycle': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            {
              from: { file: { categories: ['entry'] } },
              allow: { to: { file: { categories: ['core'] } } }
            },
            {
              from: { file: { categories: ['core'] } },
              allow: { to: { file: { categories: ['core'] } } }
            }
          ]
        }
      ]
    }
  },

  {
    files: ['package.json'],
    rules: {
      'package-json/dependency-version-range': ['error', { exceptions: ['@opencode-ai/plugin'] }],
      'package-json/no-dist-tag-dependencies': 'off'
    }
  }
])
