import globals from 'globals';

export default [
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            // Errores comunes
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-undef': 'error',
            'no-const-assign': 'error',
            'no-dupe-keys': 'error',
            'no-duplicate-case': 'error',

            // Buenas prácticas
            'eqeqeq': ['error', 'always'],
            'no-var': 'error',
            'prefer-const': 'warn',
            'radix': 'error',
            'no-throw-literal': 'error',

            // Estilo
            'semi': ['warn', 'always'],
            'quotes': ['warn', 'single', { avoidEscape: true }],
            'indent': ['warn', 4, { SwitchCase: 1 }],
            'no-trailing-spaces': 'warn',
            'no-multiple-empty-lines': ['warn', { max: 2 }],
        },
    },
    {
        ignores: ['node_modules/**'],
    },
];
