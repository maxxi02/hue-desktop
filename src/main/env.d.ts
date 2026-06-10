/** Vite raw-import: `import page from './phone-page.html?raw'` yields the file as a string. */
declare module '*.html?raw' {
  const content: string
  export default content
}
