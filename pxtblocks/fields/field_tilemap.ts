/// <reference path="../../built/pxtlib.d.ts" />


namespace pxtblockly {
    import svg = pxt.svgUtil;

    export interface FieldTilemapOptions {
        initWidth: string;
        initHeight: string;
        tileWidth: string | number;

        filter?: string;
    }

    interface ParsedFieldTilemapOptions {
        initWidth: number;
        initHeight: number;
        tileWidth: 8 | 16 | 32;
        filter?: string;
    }

    // 32 is specifically chosen so that we can scale the images for the default
    // sprite sizes without getting browser anti-aliasing
    const PREVIEW_WIDTH = 32;
    const X_PADDING = 5;
    const Y_PADDING = 1;
    const BG_PADDING = 4;
    const BG_WIDTH = BG_PADDING * 2 + PREVIEW_WIDTH;
    const TOTAL_HEIGHT = Y_PADDING * 2 + BG_PADDING * 2 + PREVIEW_WIDTH;
    const TOTAL_WIDTH = X_PADDING * 2 + BG_PADDING * 2 + PREVIEW_WIDTH;

    export class FieldTilemap extends Blockly.Field implements Blockly.FieldCustom {
        public isFieldCustom_ = true;
        public SERIALIZABLE = true;

        private params: ParsedFieldTilemapOptions;
        private blocksInfo: pxtc.BlocksInfo;
        private state: pxt.sprite.TilemapData;
        private lightMode: boolean;
        private undoRedoState: any;

        private initText: string;
        private tilemapId: string;

        isGreyBlock: boolean;

        constructor(text: string, params: any, validator?: Function) {
            super(text, validator);

            this.lightMode = params.lightMode;
            this.params = parseFieldOptions(params);
            this.blocksInfo = params.blocksInfo;

            // Update now that we have blocksinfo
            if (text && !this.state) this.doValueUpdate_(text);

            this.initState();
        }

        init() {
            if (this.fieldGroup_) {
                // Field has already been initialized once.
                return;
            }
            // Build the DOM.
            this.fieldGroup_ = Blockly.utils.dom.createSvgElement('g', {}, null) as SVGGElement;
            if (!this.visible_) {
                (this.fieldGroup_ as any).style.display = 'none';
            }

            this.initState();

            this.redrawPreview();

            this.updateEditable();
            (this.sourceBlock_ as Blockly.BlockSvg).getSvgRoot().appendChild(this.fieldGroup_);

            // Force a render.
            this.render_();
            (this as any).mouseDownWrapper_ = Blockly.bindEventWithChecks_((this as any).getClickTarget_(), "mousedown", this, (this as any).onMouseDown_)
        }

        showEditor_() {
            if (this.isGreyBlock) return;

            (this.params as any).blocksInfo = this.blocksInfo;

            this.state.projectReferences = getAllReferencedTiles(this.sourceBlock_.workspace, this.sourceBlock_.id).map(t => t.id);
            const project = pxt.react.getTilemapProject();

            const allTiles = project.getProjectTiles(this.state.tileset.tileWidth, true);

            for (const tile of allTiles.tiles) {
                if (!this.state.tileset.tiles.some(t => t.id === tile.id)) {
                    this.state.tileset.tiles.push(tile);
                }
            }

            for (const tile of this.state.tileset.tiles) {
                tile.weight = allTiles.tiles.findIndex(t => t.id === tile.id);
            }

            const fv = pxt.react.getFieldEditorView("tilemap-editor", this.state, this.params);

            if (this.undoRedoState) {
                fv.restorePersistentData(this.undoRedoState);
            }

            fv.onHide(() => {
                const result = fv.getResult();

                if (result) {
                    const old = this.getValue();

                    this.state = result;
                    this.state.projectReferences = null;


                    const lastRevision = project.revision();
                    project.pushUndo();

                    if (result.deletedTiles) {
                        for (const deleted of result.deletedTiles) {
                            project.deleteTile(deleted);
                        }
                    }

                    if (result.editedTiles) {
                        for (const edit of result.editedTiles) {
                            const editedIndex = result.tileset.tiles.findIndex(t => t.id === edit);
                            const edited = result.tileset.tiles[editedIndex];

                            // New tiles start with *. We haven't created them yet so ignore
                            if (!edited || edited.id.startsWith("*")) continue;

                            result.tileset.tiles[editedIndex] = project.updateTile(edited.id, edited.bitmap);
                        }
                    }

                    for (let i = 0; i < result.tileset.tiles.length; i++) {
                        const tile = result.tileset.tiles[i];

                        if (tile.id.startsWith("*")) {
                            const newTile = project.createNewTile(tile.bitmap);
                            result.tileset.tiles[i] = newTile;
                        }
                        else if (!tile.data) {
                            result.tileset.tiles[i] = project.resolveTile(tile.id);
                        }
                    }

                    pxt.sprite.trimTilemapTileset(result);

                    if (this.tilemapId) {
                        project.updateTilemap(this.tilemapId, result);
                    }

                    this.redrawPreview();

                    this.undoRedoState = fv.getPersistentData();

                    const newValue = this.getValue();

                    if (old !== newValue) {
                        project.forceUpdate();
                    }

                    if (this.sourceBlock_ && Blockly.Events.isEnabled()) {
                        Blockly.Events.fire(new BlocklyTilemapChange(
                            this.sourceBlock_, 'field', this.name, old, this.getValue(), lastRevision, project.revision()));
                    }
                }
            });

            fv.show();
        }

        render_() {
            super.render_();

            if (!this.isGreyBlock) {
                this.size_.height = TOTAL_HEIGHT;
                this.size_.width = TOTAL_WIDTH;
            }
        }

        getValue() {
            if (this.isGreyBlock) return pxt.Util.htmlUnescape(this.value_);

            if (this.tilemapId) {
                return `tilemap\`${this.tilemapId}\``;
            }

            try {
                return pxt.sprite.encodeTilemap(this.state, "typescript");
            }
            catch (e) {
                // If encoding failed, this is a legacy tilemap. Should get upgraded when the project is loaded
                return this.getInitText();
            }
        }

        getTileset() {
            return this.state.tileset;
        }

        getInitText() {
            return this.initText;
        }

        doValueUpdate_(newValue: string) {
            if (newValue == null) {
                return;
            }
            this.value_ = newValue;
            this.parseBitmap(newValue);
            this.redrawPreview();

            super.doValueUpdate_(newValue);
        }

        redrawPreview() {
            if (!this.fieldGroup_) return;
            pxsim.U.clear(this.fieldGroup_);

            if (this.isGreyBlock) {
                this.createTextElement_();
                this.updateEditable();
                return;
            }

            const bg = new svg.Rect()
                .at(X_PADDING, Y_PADDING)
                .size(BG_WIDTH, BG_WIDTH)
                .setClass("blocklyTilemapField")
                .corner(4);

            this.fieldGroup_.appendChild(bg.el);

            if (this.state) {
                const data = tilemapToImageURI(this.state, PREVIEW_WIDTH, this.lightMode, this.blocksInfo);
                const img = new svg.Image()
                    .src(data)
                    .at(X_PADDING + BG_PADDING, Y_PADDING + BG_PADDING)
                    .size(PREVIEW_WIDTH, PREVIEW_WIDTH);
                this.fieldGroup_.appendChild(img.el);
            }
        }

        refreshTileset() {
            const project = pxt.react.getTilemapProject();
            if (this.tilemapId) {
                this.state = project.getTilemap(this.tilemapId);
            }
            else if (this.state) {
                for (let i = 0; i < this.state.tileset.tiles.length; i++) {
                    this.state.tileset.tiles[i] = project.resolveTile(this.state.tileset.tiles[i].id);
                }
            }
        }

        private parseBitmap(newText: string) {
            if (!this.blocksInfo) return;

            if (newText) {
                // backticks are escaped inside markdown content
                newText = newText.replace(/&#96;/g, "`");
            }

            const match = /^\s*tilemap\s*`([^`]*)`\s*$/.exec(newText);

            if (match) {
                const tilemapId = match[1].trim();
                this.state = pxt.react.getTilemapProject().getTilemap(tilemapId);

                if (this.state) {
                    this.tilemapId = tilemapId;
                    return;
                }
            }

            const tilemap = pxt.sprite.decodeTilemap(newText, "typescript", pxt.react.getTilemapProject()) || emptyTilemap(this.params.tileWidth, this.params.initWidth, this.params.initHeight);

            // Ignore invalid bitmaps
            if (checkTilemap(tilemap)) {
                this.initText = newText;
                this.state = tilemap;
                this.isGreyBlock = false;
            }
            else if (newText.trim()) {
                this.isGreyBlock = true;
                this.value_ = newText;
            }
        }

        protected initState() {
            if (!this.state) {
                this.state = pxt.react.getTilemapProject().blankTilemap(this.params.tileWidth, this.params.initWidth, this.params.initHeight);
            }
        }

        getDisplayText_() {
            const text = pxt.Util.htmlUnescape(this.value_);
            return text.substr(0, text.indexOf("(")) + "(...)";;
        }

        updateEditable() {
            if (this.isGreyBlock && this.fieldGroup_) {
                const group = this.fieldGroup_;
                Blockly.utils.dom.removeClass(group, 'blocklyNonEditableText');
                Blockly.utils.dom.removeClass(group, 'blocklyEditableText');
                group.style.cursor = '';
            }
            else {
                super.updateEditable();
            }
        }
    }

    function parseFieldOptions(opts: FieldTilemapOptions) {
        const parsed: ParsedFieldTilemapOptions = {
            initWidth: 16,
            initHeight: 16,
            tileWidth: 16
        };

        if (!opts) {
            return parsed;
        }

        if (opts.filter) {
            parsed.filter = opts.filter;
        }

        if (opts.tileWidth) {
            if (typeof opts.tileWidth === "number") {
                switch (opts.tileWidth) {
                    case 8:
                        parsed.tileWidth = 8;
                        break;
                    case 16:
                        parsed.tileWidth = 16;
                        break;
                    case 32:
                        parsed.tileWidth = 32;
                        break;
                }
            }
            else {
                const tw = opts.tileWidth.trim().toLowerCase();
                switch (tw) {
                    case "8":
                    case "eight":
                        parsed.tileWidth = 8;
                        break;
                    case "16":
                    case "sixteen":
                        parsed.tileWidth = 16;
                        break;
                    case "32":
                    case "thirtytwo":
                        parsed.tileWidth = 32;
                        break;
                }
            }
        }

        parsed.initWidth = withDefault(opts.initWidth, parsed.initWidth);
        parsed.initHeight = withDefault(opts.initHeight, parsed.initHeight);

        return parsed;

        function withDefault(raw: string, def: number) {
            const res = parseInt(raw);
            if (isNaN(res)) {
                return def;
            }
            return res;
        }
    }
    function checkTilemap(tilemap: pxt.sprite.TilemapData) {
        if (!tilemap || !tilemap.tilemap || !tilemap.tilemap.width || !tilemap.tilemap.height) return false;

        if (!tilemap.layers || tilemap.layers.width !== tilemap.tilemap.width || tilemap.layers.height !== tilemap.tilemap.height) return false;

        if (!tilemap.tileset) return false;

        return true;
    }

    class BlocklyTilemapChange extends Blockly.Events.BlockChange {

        constructor(block: Blockly.Block, element: string, name: string, oldValue: any, newValue: any, protected oldRevision: number, protected newRevision: number) {
            super(block, element, name, oldValue, newValue);
        }

        isNull() {
            return this.oldRevision === this.newRevision && super.isNull();
        }

        run(forward: boolean) {
            if (forward) {
                pxt.react.getTilemapProject().redo();
                super.run(forward);
            }
            else {
                pxt.react.getTilemapProject().undo();
                super.run(forward);
            }

            const ws = this.getEventWorkspace_();
            const tilemaps = getAllBlocksWithTilemaps(ws);

            for (const t of tilemaps) {
                t.ref.refreshTileset();
                t.ref.redrawPreview();
            }

            // Fire an event to force a recompile, but make sure it doesn't end up on the undo stack
            const ev = new BlocklyTilemapChange(
                ws.getBlockById(this.blockId), 'tilemap-revision', "revision", null, pxt.react.getTilemapProject().revision(), 0, 0);
            ev.recordUndo = false;

            Blockly.Events.fire(ev)
        }
    }

    function emptyTilemap(tileWidth: number, width: number, height: number) {
        return new pxt.sprite.TilemapData(
            new pxt.sprite.Tilemap(width, height),
            {tileWidth: tileWidth, tiles: []},
            new pxt.sprite.Bitmap(width, height).data()
        );
    }
}
