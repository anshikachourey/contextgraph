const http = require('http');
const fs = require('fs');
const url = 'http://localhost:3000/api/debug/v2-trace?id=848f993f-cd70-4192-ad6d-a6bd2afb9d9d';

http.get(url, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const out = { status: res.statusCode };
    try {
      const j = JSON.parse(data);
      const obj = j['05_objects'];
      out.objectCount = obj?.count;
      out.rejected = obj?.rejected;
      out.parseAttempts = obj?.parseAttempts;
      out.parseSucceeded = obj?.parseSucceeded;
      out.parseError = obj?.parseError;
      out.rawResponseLength = obj?.rawResponseLength;
      out.inputPropositionCount = obj?.inputPropositionCount;
      out.inputThreadCount = obj?.inputThreadCount;
      out.rawClaudeResponse = obj?.rawClaudeResponse?.slice(0, 3000);
      out.parsedObjectsBeforeValidation = obj?.parsedObjectsBeforeValidation;
      out.perObjectRejections = obj?.perObjectRejections;
      out.rejectionReasons = obj?.rejectionReasons;
      // Also capture thread/prop context
      out.propositionCount = j['03_propositions']?.count;
      out.threadCount = j['04_threads']?.count;
      out.threadItems = j['04_threads']?.items;
      // Sample of real prop IDs for debugging
      const props = j['03_propositions']?.items || [];
      out.samplePropIds = props.slice(0, 5).map(p => p.propositionId);
      out.totalPropIds = props.length;
    } catch(e) {
      out.parseError = e.message;
      out.rawStart = data.slice(0, 500);
    }
    fs.writeFileSync('/tmp/obj-debug.json', JSON.stringify(out, null, 2));
    process.exit(0);
  });
}).on('error', e => {
  fs.writeFileSync('/tmp/obj-debug.json', JSON.stringify({error: e.message}));
  process.exit(1);
});
