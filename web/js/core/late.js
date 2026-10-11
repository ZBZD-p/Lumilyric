/* Names that a module needs from a module that is loaded after it (the page's modules call each other in both
   directions: settings.js calls follow.js, follow.js calls settings.js ...). A static import of such a name would make
   the later module run before the earlier one, so the later module puts it here when it has loaded (the end of its
   file) and the earlier ones call it as late.name at run time, never while loading. */
export const late = {};
