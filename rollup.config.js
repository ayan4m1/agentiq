import terser from '@rollup/plugin-terser';
import shebang from 'rollup-plugin-shebang-bin';
import autoExternal from 'rollup-plugin-auto-external';
import multiInput from '@ayan4m1/rollup-plugin-multi-input';
import typescript from '@rollup/plugin-typescript';

export default {
  input: './src/**/*.ts',
  output: {
    dir: './lib',
    format: 'esm'
  },
  plugins: [
    typescript(),
    autoExternal({
      builtins: true
    }),
    multiInput(),
    shebang(),
    terser()
  ]
};
