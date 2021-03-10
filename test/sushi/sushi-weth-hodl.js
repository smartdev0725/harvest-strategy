// Utilities
const Utils = require("../utilities/Utils.js");
const { impersonates, setupCoreProtocol, depositVault } = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const { send } = require("@openzeppelin/test-helpers");
const BigNumber = require("bignumber.js");
const IERC20 = artifacts.require("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20");

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("SushiHodlStrategyMainnet_SUSHI_WETH");
const PotPool = artifacts.require("PotPool");

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Sushi: SUSHI:WETH", function() {
  let accounts;

  // external contracts
  let underlying;
  let fSushi;

  // external setup
  let underlyingWhale = "0x4f76ff660dc5e37b098de28e6ec32978e4b5beb6";

  // parties in the protocol
  let governance;
  let farmer1;

  // numbers used in tests
  let farmerBalance;

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;

  async function setupExternalContracts() {
    underlying = await IERC20.at("0x795065dCc9f64b5614C407a6EFDC400DA6221FB0");
    fSushi = await IERC20.at("0x274AA8B58E8C57C4e347C8768ed853Eb6D375b48");
    console.log("Fetching Underlying at: ", underlying.address);
  }

  async function setupBalance(){
    let etherGiver = accounts[9];
    // Give whale some ether to make sure the following actions are good
    await send.ether(etherGiver, underlyingWhale, "1" + "000000000000000000");

    farmerBalance = await underlying.balanceOf(underlyingWhale);
    await underlying.transfer(farmer1, farmerBalance, { from: underlyingWhale });
  }

  before(async function() {
    governance = "0xf00dD244228F51547f0563e60bCa65a30FBF5f7f";
    accounts = await web3.eth.getAccounts();

    farmer1 = accounts[1];

    // impersonate accounts
    await impersonates([governance, underlyingWhale]);

    await setupExternalContracts();
    [controller, vault, strategy, potPool] = await setupCoreProtocol({
      "existingVaultAddress": null,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "underlying": underlying,
      "governance": governance,
      "rewardPool" : true,
      "rewardPoolConfig": {
        type: 'PotPool',
        rewardTokens: [
          addresses.IFARM,
          "0x274AA8B58E8C57C4e347C8768ed853Eb6D375b48" // fSUSHI
        ]
      },
    });
    console.log(await strategy.potPool());
    await strategy.setPotPool(potPool.address, {from: governance});
    await potPool.setRewardDistribution([strategy.address], true, {from: governance});

    // whale send underlying to farmers
    await setupBalance();
  });

  describe("Happy path", function() {
    it("Farmer should earn money", async function() {
      let farmerOldBalance = new BigNumber(await underlying.balanceOf(farmer1));
      let farmerOldFSushi = new BigNumber(await fSushi.balanceOf(farmer1));

      await depositVault(farmer1, underlying, vault, farmerBalance);
      const vaultBalance = new BigNumber(await vault.balanceOf(farmer1));

      let erc20Vault = await IERC20.at(vault.address);

      await erc20Vault.approve(potPool.address, vaultBalance, {from: farmer1});
      await potPool.stake(vaultBalance, {from: farmer1});

      // Using half days is to simulate how we doHardwork in the real world
      let hours = 10;
      let oldSharePrice;
      let newSharePrice;
      for (let i = 0; i < hours; i++) {
        console.log("loop ", i);
        let blocksPerHour = 2400;
        oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        await controller.doHardWork(vault.address, { from: governance });
        newSharePrice = new BigNumber(await vault.getPricePerFullShare());

        console.log("old shareprice: ", oldSharePrice.toFixed());
        console.log("new shareprice: ", newSharePrice.toFixed());
        console.log("growth: ", newSharePrice.toFixed() / oldSharePrice.toFixed());

        console.log("fSushi in potpool: ", (new BigNumber(await fSushi.balanceOf(potPool.address))).toFixed() );

        await Utils.advanceNBlock(blocksPerHour);
      }

      // withdrawAll to make sure no doHardwork is called when we do withdraw later.
      await vault.withdrawAll({ from: governance });

      // wait until all reward can be claimed by the farmer
      await Utils.waitTime(86400 * 30 * 1000);
      console.log("vaultBalance: ", vaultBalance.toFixed());
      await potPool.exit({from: farmer1});
      await vault.withdraw(vaultBalance.toFixed(), { from: farmer1 });
      let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));
      let farmerNewfSushi = new BigNumber(await fSushi.balanceOf(farmer1));
      Utils.assertBNEq(farmerNewBalance, farmerOldBalance);
      Utils.assertBNGt(farmerNewfSushi, farmerOldFSushi);

      console.log("potpool totalShare: ", (new BigNumber(await potPool.totalSupply())).toFixed());
      console.log("fSushi in potpool: ", (new BigNumber(await fSushi.balanceOf(potPool.address))).toFixed() );
      console.log("Farmer got fSushi from potpool: ", farmerNewfSushi.toFixed());
      console.log("earned!");
    });
  });
});
