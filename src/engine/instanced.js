// One draw call for N sprites.
//
// This is the single most important primitive in the engine. The Canvas 2D
// renderer it replaces issued one drawImage per visible element, which put
// a hard ceiling on how much detail a scene could hold — a few thousand
// calls per frame and the budget is gone. Here, a tree's entire canopy,
// a whole snowfall, or every ember above a fire is ONE
// drawArraysInstanced: the per-instance data lives in a buffer the GPU
// reads itself, and the CPU's only per-frame job is uploading whatever
// actually changed.

export class InstancedQuads {
  /// `attribs` describes the per-instance layout, e.g.
  ///   [{ name: 'aPos', size: 3 }, { name: 'aParam', size: 4 }]
  /// Offsets and stride are derived, so adding a field is one line.
  constructor(gl, program, attribs) {
    this.gl = gl;
    this.count = 0;
    this.capacity = 0;
    this.stride = attribs.reduce((n, a) => n + a.size, 0);
    this.attribs = attribs;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // Unit quad as a triangle strip, shared by every instance.
    this.cornerBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    const corner = gl.getAttribLocation(program, 'aCorner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    let offset = 0;
    for (const a of attribs) {
      const loc = gl.getAttribLocation(program, a.name);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, a.size, gl.FLOAT, false, this.stride * 4, offset * 4);
        // The whole point: advance this attribute once per INSTANCE
        // rather than once per vertex.
        gl.vertexAttribDivisor(loc, 1);
      }
      offset += a.size;
    }
    gl.bindVertexArray(null);
  }

  /// Uploads instance data. `data` is a flat Float32Array laid out in the
  /// attribute order given to the constructor.
  upload(data, count, usage) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (count > this.capacity) {
      // Grow with slack so a particle system that ramps its count up does
      // not reallocate the buffer on every step.
      this.capacity = Math.ceil(count * 1.3);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity * this.stride * 4, usage ?? gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * this.stride);
    this.count = count;
  }

  draw(count = this.count) {
    if (count <= 0) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.cornerBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteVertexArray(this.vao);
  }
}

/// Helper for building instance arrays without index arithmetic at every
/// call site.
export class InstanceWriter {
  constructor(stride, capacity) {
    this.stride = stride;
    this.data = new Float32Array(stride * capacity);
    this.i = 0;
    this.count = 0;
  }

  push(...values) {
    if ((this.count + 1) * this.stride > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    for (let k = 0; k < values.length; k++) this.data[this.i++] = values[k];
    this.count++;
  }

  reset() {
    this.i = 0;
    this.count = 0;
  }
}
