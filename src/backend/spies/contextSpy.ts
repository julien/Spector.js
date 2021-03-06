namespace SPECTOR {

    export interface IContextSpy {
        context: WebGLRenderingContexts;
        version: number;

        spy(): void;
        unSpy(): void;

        startCapture(): void;
        stopCapture(): ICapture;
        isCapturing(): boolean;

        getNextCommandCaptureId(): number;
    }

    export interface IContextSpyOptions {
        context: WebGLRenderingContexts;
        version: number;
        recordAlways?: boolean;
        injection: InjectionType;
    }

    export type ContextSpyConstructor = {
        new (options: IContextSpyOptions, time: ITime, logger: ILogger): IContextSpy;
    };
}

namespace SPECTOR.Spies {
    export class ContextSpy implements IContextSpy {

        private static readonly unSpyableMembers = ["canvas",
            "drawingBufferWidth",
            "drawingBufferHeight",
            "glp", // WebGl Insight internal method.
        ];

        public readonly context: WebGLRenderingContexts;
        public readonly version: number;

        private readonly contextInformation: IContextInformation;
        private readonly commandSpies: { [key: string]: ICommandSpy };
        private readonly stateSpy: IStateSpy;
        private readonly recorderSpy: IRecorderSpy;
        private readonly webGlObjectSpy: IWebGlObjectSpy;
        private readonly injection: InjectionType;

        private capturing: boolean;
        private globalCapturing: boolean;
        private commandId: number;
        private currentCapture: ICapture;
        private canvasCapture: ICanvasCapture;
        private contextCapture: IContextCapture;
        private analyser: ICaptureAnalyser;

        constructor(private readonly options: IContextSpyOptions,
            private readonly time: ITime,
            private readonly logger: ILogger) {

            this.commandId = 0;
            this.context = options.context;
            this.version = options.version;
            this.capturing = false;
            this.globalCapturing = true;

            this.injection = options.injection;

            this.contextInformation = {
                context: this.context,
                contextVersion: this.version,
                toggleCapture: this.toggleGlobalCapturing.bind(this),
                tagWebGlObject: this.tagWebGlObject.bind(this),
                extensions: {},
            };

            this.commandSpies = {};
            this.stateSpy = new this.injection.StateSpyCtor({
                contextInformation: this.contextInformation,
                stateNamespace: this.injection.StateNamespace,
            },
                logger);
            this.recorderSpy = new this.injection.RecorderSpyCtor({
                contextInformation: this.contextInformation,
                recorderNamespace: this.injection.RecorderNamespace,
                timeConstructor: this.injection.TimeCtor,
            }, logger);
            this.webGlObjectSpy = new this.injection.WebGlObjectSpyCtor({
                contextInformation: this.contextInformation,
                webGlObjectNamespace: this.injection.WebGlObjectNamespace,
            }, logger);
            this.analyser = new this.injection.CaptureAnalyserCtor({
                contextInformation: this.contextInformation,
                analyserNamespace: this.injection.AnalyserNamespace,
            }, logger);

            this.initStaticCapture();

            if (options.recordAlways) {
                this.spy();
            }
        }

        public spy(): void {
            this.spyContext(this.context);
            const { extensions } = this.contextInformation;
            for (const extensionName in extensions) {
                if (extensions.hasOwnProperty(extensionName)) {
                    this.spyContext(extensions[extensionName]);
                }
            }
        }

        public unSpy(): void {
            for (const member in this.commandSpies) {
                if (this.commandSpies.hasOwnProperty(member)) {
                    this.commandSpies[member].unSpy();
                }
            }
        }

        public startCapture(): void {
            const startTime = this.time.now;
            if (!this.options.recordAlways) {
                this.spy();
            }

            this.capturing = true;
            this.commandId = 0;
            this.currentCapture = {
                canvas: this.canvasCapture,
                context: this.contextCapture,
                commands: [],
                initState: {},
                endState: {},
                startTime,
                listenCommandsStartTime: 0,
                listenCommandsEndTime: 0,
                endTime: 0,
                analyses: [],
                frameMemory: {},
                memory: {},
            };

            this.stateSpy.startCapture(this.currentCapture);
            this.recorderSpy.startCapture();

            this.currentCapture.listenCommandsStartTime = this.time.now;
        }

        public stopCapture(): ICapture {
            const listenCommandsEndTime = this.time.now;
            if (!this.options.recordAlways) {
                this.unSpy();
            }

            this.capturing = false;
            this.stateSpy.stopCapture(this.currentCapture);
            this.recorderSpy.stopCapture();

            this.currentCapture.listenCommandsEndTime = listenCommandsEndTime;
            this.currentCapture.endTime = this.time.now;

            this.recorderSpy.appendRecordedInformation(this.currentCapture);
            this.analyser.appendAnalyses(this.currentCapture);
            return this.currentCapture;
        }

        public isCapturing(): boolean {
            return this.globalCapturing && this.capturing;
        }

        public getNextCommandCaptureId(): number {
            return this.commandId++;
        }

        public onCommand(commandSpy: ICommandSpy, functionInformation: IFunctionInformation): void {
            if (!this.globalCapturing) {
                return;
            }

            this.webGlObjectSpy.tagWebGlObjects(functionInformation);
            this.recorderSpy.recordCommand(functionInformation);

            if (this.isCapturing()) {
                const commandCapture = commandSpy.createCapture(functionInformation, this.getNextCommandCaptureId());
                this.stateSpy.captureState(commandCapture);
                this.currentCapture.commands.push(commandCapture);

                commandCapture.endTime = this.time.now;
            }
        }

        private spyContext(bindingContext: any) {
            for (const member in bindingContext) {
                if (~ContextSpy.unSpyableMembers.indexOf(member)) {
                    continue;
                }

                try {
                    const isFunction = typeof bindingContext[member] !== "number";
                    if (isFunction) {
                        this.spyFunction(member, bindingContext);
                    }
                }
                catch (e) {
                    this.logger.error("Cant Spy member: " + member);
                    this.logger.error(e);
                }
            }
        }

        private initStaticCapture(): void {
            const extensionsState = new this.injection.ExtensionsCtor(this.contextInformation, this.logger);
            const extensions = extensionsState.getExtensions();
            for (const extensionName in extensions) {
                if (extensions.hasOwnProperty(extensionName)) {
                    this.contextInformation.extensions[extensionName] = extensions[extensionName];
                }
            }

            const capabilitiesState = new this.injection.CapabilitiesCtor(this.contextInformation, this.logger);
            const compressedTextures = new this.injection.CompressedTexturesCtor(this.contextInformation, this.logger);

            this.contextCapture = {
                version: this.version,
                contextAttributes: this.context.getContextAttributes(),
                capabilities: capabilitiesState.getStateData(),
                extensions: extensionsState.getStateData(),
                compressedTextures: compressedTextures.getStateData(),
            };

            this.canvasCapture = {
                width: this.context.canvas.width,
                height: this.context.canvas.height,
                clientWidth: this.context.canvas.clientWidth,
                clientHeight: this.context.canvas.clientHeight,
                browserAgent: navigator ? navigator.userAgent : "",
            };
        }

        private spyFunction(member: string, bindingContext: any) {
            if (!this.commandSpies[member]) {
                const options = merge(this.contextInformation, {
                    spiedCommandName: member,
                    spiedCommandRunningContext: bindingContext,
                    callback: this.onCommand.bind(this),
                    commandNamespace: this.injection.CommandNamespace,
                    stackTraceCtor: this.injection.StackTraceCtor,
                    defaultCommandCtor: this.injection.DefaultCommandCtor,
                });
                this.commandSpies[member] = new this.injection.CommandSpyCtor(options, this.time, this.logger);
            }
            this.commandSpies[member].spy();
        }

        private toggleGlobalCapturing(capture: boolean) {
            this.globalCapturing = capture;
        }

        private tagWebGlObject(object: any): WebGlObjectTag {
            return this.webGlObjectSpy.tagWebGlObject(object);
        }
    }
}
