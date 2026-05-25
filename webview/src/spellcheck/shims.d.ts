declare module "*?raw" {
  const content: string
  export default content
}

declare module "nspell" {
  type Suggester = {
    correct(word: string): boolean
    suggest(word: string): string[]
  }
  function nspell(aff: string, dic: string): Suggester
  export default nspell
}
