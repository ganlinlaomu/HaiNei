export class BoundedSet<T> extends Set<T> {
  constructor(private readonly capacity = 4096) {
    super();
  }
  override add(value: T): this {
    this.delete(value);
    super.add(value);
    if (this.size > this.capacity) this.delete(this.values().next().value!);
    return this;
  }
}
