class RawPart {
    constructor(value) {
        this.value = value;
    }
    toSQL() {
        return {sql: this.value}
    }
    toString() {
        return this.value;
    }
}

RawPart.prototype.isRawInstance = true;

module.exports = RawPart;