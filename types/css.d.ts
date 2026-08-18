/** CSS Modules：构建时由 lightningcss 编成哈希类名表（见 tsdown.config.ts）。 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
