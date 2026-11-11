import test from 'node:test';
import assert from 'node:assert/strict';
import {frameMetrics} from '../core/metrics.mjs';
test('measures independent source and previous RGB differences; missing is null not fake zero',()=>{
 const rgba=new Uint8Array([0,0,0,255,255,255,255,128]);const black={width:2,height:1,rgba:new Uint8Array([0,0,0,255,0,0,0,255])};
 const result=frameMetrics(rgba,2,1,{source:black,previous:{width:2,height:1,rgba}});
 assert.equal(result.difference_source,0.5);assert.equal(result.difference_previous,0);
 assert.equal(frameMetrics(rgba,2,1).difference_source,null);
 assert.equal(frameMetrics(rgba,2,1,{previous:{width:1,height:1,rgba:new Uint8Array(4)}}).difference_previous,null);
 assert.match(result.metrics_scope,/RGB/);
});
