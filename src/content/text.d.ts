// Wrangler bundles *.txt as text modules (default module rules).
declare module "*.txt" {
  const text: string;
  export default text;
}
