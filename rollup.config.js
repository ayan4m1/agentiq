import terser from '@rollup/plugin-terser';
import shebang from 'rollup-plugin-shebang-bin';
import externals from 'rollup-plugin-node-externals';
import multiInput from '@ayan4m1/rollup-plugin-multi-input';
import typescript from '@rollup/plugin-typescript';

export default {
  // declarations match the glob but have nothing to emit, so excluding them
  // keeps rollup from making an empty chunk out of each one. tests sit beside
  // what they cover and are not part of the shipped bundle
  input: ['./src/**/*.ts', '!./src/**/*.d.ts', '!./src/**/*.test.ts'],
  output: {
    dir: './lib',
    format: 'esm',
    preserveModules: true
  },
  plugins: [typescript(), externals(), multiInput(), shebang(), terser()]
};
