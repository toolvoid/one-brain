'use strict';
(function(root){
 function createInsertionGuard(){const chats=new Map();let lastGlobal=-Infinity;let paused=false;return {attempt(chat,now){if(paused)return {allowed:false,paused:true};const state=chats.get(chat)||{count:0,last:-Infinity};if(now-state.last<5000){paused=true;return {allowed:false,looped:true};}if(now-lastGlobal<30000||state.count>=3)return {allowed:false};state.count++;state.last=now;lastGlobal=now;chats.set(chat,state);return {allowed:true};},pause(){paused=true;},isPaused(){return paused;}};}
 const api={createInsertionGuard};if(typeof module!=='undefined')module.exports=api;root.OneBrainInsertionGuard=api;
})(globalThis);
