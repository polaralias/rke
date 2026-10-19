/** Quote one literal argument for a POSIX shell, including embedded apostrophes. */
export function shellQuote(value:string):string {
  if(value.includes("\0"))throw new Error("Shell arguments cannot contain NUL.");
  return "'"+value.replaceAll("'", "'\"'\"'")+"'";
}
