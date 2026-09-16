import terser from '@rollup/plugin-terser';
import shebang from 'rollup-plugin-shebang-bin';
import autoExternal from 'rollup-plugin-auto-external';
import multiInput from '@ayan4m1/rollup-plugin-multi-input';
import typescript from '@rollup/plugin-typescript';

export default {
  // declarations match the glob but have nothing to emit, so excluding them
  // keeps rollup from making an empty chunk out of each one
  input: ['./src/**/*.ts', '!./src/**/*.d.ts'],
  output: {
    dir: './lib',
    format: 'esm',
    preserveModules: true
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
