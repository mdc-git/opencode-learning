import { fileURLToPath } from 'node:url'
import { defineConfig } from 'eslint/config'
import boundaries from 'eslint-plugin-boundaries'
import sonarjs from 'eslint-plugin-sonarjs'
import eslintConfigXo from 'eslint-config-xo'
import globals from 'globals'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

export default defineConfig([
  ...eslintConfigXo({
    space: true,
    semicolon: false,
    prettier: 'compat',
    gitignore: new URL('../.gitignore', import.meta.url).href
  }),

  {
    ignores: ['node_modules/**', '.opencode/**', 'AGENTS.md']
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
        typescript: { project: 'tooling/tsconfig.json' }
      },
      'boundaries/files': [
        { pattern: 'plugins/opencode-learning/index.ts', category: 'entry' },
        {
          pattern:
            'plugins/opencode-learning/{candidates,evidence,proposal,review,review-generate,review-packet,review-prompts,review-schema,rpc,rpc-server,skill-files,skill-markdown,skill-tree,store,tui}.ts',
          category: 'core'
        }
      ]
    },
    plugins: {
      sonarjs,
      boundaries
    },
    rules: {
      complexity: ['error', 4],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'max-lines-per-function': ['error', 50],
      'max-lines': ['error', { max: 300 }],
      'sonarjs/cognitive-complexity': ['error', 4],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'FunctionDeclaration ImportExpression, FunctionExpression ImportExpression, ArrowFunctionExpression ImportExpression, StaticBlock ImportExpression',
          message:
            'Do not use dynamic `import()` inside a function. Use a top-level static import instead.'
        },
        {
          selector:
            'FunctionDeclaration CallExpression[callee.name="require"], FunctionExpression CallExpression[callee.name="require"], ArrowFunctionExpression CallExpression[callee.name="require"], StaticBlock CallExpression[callee.name="require"], FunctionDeclaration CallExpression[callee.object.name="require"], FunctionExpression CallExpression[callee.object.name="require"], ArrowFunctionExpression CallExpression[callee.object.name="require"], StaticBlock CallExpression[callee.object.name="require"]',
          message:
            'Do not use `require()` inside a function. Use a top-level static import instead.'
        }
      ],
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
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tooling/tsconfig.json',
        projectService: false,
        tsconfigRootDir: repositoryRoot
      }
    },
    settings: {
      n: {
        tsconfigPath: 'tooling/tsconfig.json'
      }
    }
  },

  {
    files: ['package.json'],
    rules: {
      'package-json/dependency-version-range': ['error', { exceptions: ['effect'] }],
      'package-json/no-dist-tag-dependencies': 'off'
    }
  }
])
