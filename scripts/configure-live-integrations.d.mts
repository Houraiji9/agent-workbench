export function inside(file:string,base:string):string;
export function atomic(file:string,value:string):void;
export function configure(options:{root:string;desktopExe?:string;dataDir?:string;port?:number;agentsView?:boolean}):Promise<{baseUrl:string;secretFile:string;settingsChanged:boolean}>;
